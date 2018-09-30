import Plugin from '../Plugin';
import * as PluginTypes from '../PluginTypes';
import {Blockchains} from '../../models/Blockchains'
import * as NetworkMessageTypes from '../../messages/NetworkMessageTypes'
import StringHelpers from '../../util/StringHelpers'
import Error from '../../models/errors/Error'
import Network from '../../models/Network'
import Account from '../../models/Account'
import AlertMsg from '../../models/alerts/AlertMsg'
import * as Actions from '../../store/constants';
import Fibos from 'fibos.js'
let {ecc, Fcbuffer} = Fibos.modules;
import {IdentityRequiredFields} from '../../models/Identity';
import ObjectHelpers from '../../util/ObjectHelpers'
import * as ricardianParser from 'eos-rc-parser';
import StorageService from '../../services/StorageService'
import {strippedHost} from '../../util/GenericTools'

let networkGetter = new WeakMap();
let messageSender = new WeakMap();
let throwIfNoIdentity = new WeakMap();

const proxy = (dummy, handler) => new Proxy(dummy, handler);

export default class FIBOS extends Plugin {

    constructor(){ super(Blockchains.FIBOS, PluginTypes.BLOCKCHAIN_SUPPORT) }
    accountFormatter(account){ return `${account.name}@${account.authority}` }
    returnableAccount(account){ return { name:account.name, authority:account.authority }}

    async getEndorsedNetwork(){
        return new Promise((resolve, reject) => {
            resolve(new Network(
                'FIBOS Mainnet', 'http',
                'api.fibos.rocks',
                80,
                Blockchains.FIBOS,
                '6aa7bd33b6b45192465afa3553dedb531acaaff8928cf64b70bd4c5e49b7ec6a'
            ));
        });
    }

    async isEndorsedNetwork(network){
        const endorsedNetwork = await this.getEndorsedNetwork();
        return network.hostport() === endorsedNetwork.hostport();
    }

    accountsAreImported(){ return true; }
    importAccount(keypair, network, context, accountSelected){
        const getAccountsFromPublicKey = (publicKey, network) => {
            return new Promise((resolve, reject) => {
                const fibos = Fibos({httpEndpoint:`${network.protocol}://${network.hostport()}`});
                //console.log(`send to ${network.protocol}://${network.hostport()}`);
                fibos.getKeyAccounts(publicKey).then(res => {
                    if(!res || !res.hasOwnProperty('account_names')){ resolve([]); return false; }

                    Promise.all(res.account_names.map(name => fibos.getAccount(name).catch(e => resolve([])))).then(multires => {
                        let accounts = [];
                        multires.map(account => {
                            account.permissions.map(permission => {
                                accounts.push({name:account.account_name, authority:permission.perm_name});
                            });
                        });
                        resolve(accounts)
                    }).catch(e => resolve([]));
                }).catch(e => resolve([]));
            })
        }

        getAccountsFromPublicKey(keypair.publicKey, network).then(accounts => {
            switch(accounts.length){
                case 0: context[Actions.PUSH_ALERT](AlertMsg.NoAccountsFound()); reject(); return false;
                // Only one account, so returning it
                case 1: accountSelected(Account.fromJson({name:accounts[0].name, authority:accounts[0].authority, publicKey:keypair.publicKey, keypairUnique:keypair.unique() })); break;
                // More than one account, prompting account selection
                default: context[Actions.PUSH_ALERT](AlertMsg.SelectAccount(accounts)).then(res => {
                    if(!res || !res.hasOwnProperty('selected')) { reject(); return false; }
                    accountSelected(Account.fromJson(Object.assign(res.selected, {publicKey:keypair.publicKey, keypairUnique:keypair.unique()})));
                })
            }
        }).catch(e => {
            console.log('error', e);
            accountSelected(null);
        });
    }

    privateToPublic(privateKey){ return ecc.privateToPublic(privateKey, "FO"); }
    validPrivateKey(privateKey){ return ecc.isValidPrivate(privateKey); }
    validPublicKey(publicKey){   return ecc.isValidPublic(publicKey, "FO"); }
    randomPrivateKey(){ return ecc.randomKey(); }
    convertsTo(){
        return [];
    }
    from_eth(privateKey){
        return ecc.PrivateKey.fromHex(Buffer.from(privateKey, 'hex')).toString();
    }

    async getBalances(account, network, code = 'eosio.token', table = 'accounts'){
        const fibos = Fibos({httpEndpoint:`${network.protocol}://${network.hostport()}`, chainId:network.chainId});
        const contract = await fibos.contract(code);
        return await fibos.getTableRows({
            json: true,
            code,
            scope: account.name,
            table,
            limit: 5000
        }).then(res => res.rows.map(row => row.balance.split(' ').reverse()));
    }

    actionParticipants(payload){
        return ObjectHelpers.flatten(
            payload.messages
                .map(message => message.authorization
                    .map(auth => `${auth.actor}@${auth.permission}`))
        );
    }

    signer(bgContext, payload, publicKey, callback, arbitrary = false, isHash = false){
        bgContext.publicToPrivate(privateKey => {
            if(!privateKey){
                callback(null);
                return false;
            }

            let sig;
            if(arbitrary && isHash) sig = ecc.Signature.signHash(payload.data, privateKey).toString();
            else sig = ecc.sign(Buffer.from(arbitrary ? payload.data : payload.buf.data, 'utf8'), privateKey);

            callback(sig);
        }, publicKey)
    }

    signatureProvider(...args){

        messageSender = args[0];
        throwIfNoIdentity = args[1];

        // Protocol will be deprecated.
        return (network, _fibos, _options = {}, protocol = 'http') => {
            if(!['http', 'https', 'ws'].includes(protocol))
                throw new Error('Protocol must be either http, https, or ws');

            // Backwards compatibility: Networks now have protocols, but some older dapps still use the argument
            if(!network.hasOwnProperty('protocol') || !network.protocol.length)
                network.protocol = protocol;

            network = Network.fromJson(network);
            if(!network.isValid()) throw Error.noNetwork();
            const httpEndpoint = `${network.protocol}://${network.hostport()}`;

            // The proxy stands between the fibos.js object and scatter.
            // This is used to add special functionality like adding `requiredFields` arrays to transactions
            return proxy(_fibos({httpEndpoint, chainId:_options.chainId}), {
                get(fibosInstance, method) {

                    let returnedFields = null;

                    return (...args) => {

                        if(args.find(arg => arg.hasOwnProperty('keyProvider'))) throw Error.usedKeyProvider();

                        let requiredFields = args.find(arg => arg.hasOwnProperty('requiredFields'));
                        requiredFields = IdentityRequiredFields.fromJson(requiredFields ? requiredFields.requiredFields : {});
                        if(!requiredFields.isValid()) throw Error.malformedRequiredFields();

                        // The signature provider which gets elevated into the user's Scatter
                        const signProvider = async signargs => {
                            throwIfNoIdentity();

                            // Friendly formatting
                            signargs.messages = await requestParser(_fibos, signargs, httpEndpoint, args[0], _options.chainId);

                            const payload = Object.assign(signargs, { domain:strippedHost(), network, requiredFields });
                            const result = await messageSender(NetworkMessageTypes.REQUEST_SIGNATURE, payload);

                            // No signature
                            if(!result) return null;

                            if(result.hasOwnProperty('signatures')){
                                // Holding onto the returned fields for the final result
                                returnedFields = result.returnedFields;

                                // Grabbing buf signatures from local multi sig sign provider
                                let multiSigKeyProvider = args.find(arg => arg.hasOwnProperty('signProvider'));
                                if(multiSigKeyProvider){
                                    result.signatures.push(multiSigKeyProvider.signProvider(signargs.buf, signargs.sign));
                                }

                                // Returning only the signatures to fibos.js 
                                return result.signatures;
                            }

                            return result;
                        };

                        // TODO: We need to check about the implications of multiple fibos.js instances
                        return new Promise((resolve, reject) => {
                            _fibos(Object.assign(_options, {httpEndpoint, signProvider}))[method](...args)
                                .then(result => {

                                    // Standard method ( ie. not contract )
                                    if(!result.hasOwnProperty('fc')){
                                        result = Object.assign(result, {returnedFields});
                                        resolve(result);
                                        return;
                                    }

                                    // Catching chained promise methods ( contract .then action )
                                    const contractProxy = proxy(result, {
                                        get(instance,method){
                                            if(method === 'then') return instance[method];
                                            return (...args) => {
                                                return new Promise(async (res, rej) => {
                                                    instance[method](...args).then(actionResult => {
                                                        res(Object.assign(actionResult, {returnedFields}));
                                                    }).catch(rej);
                                                })

                                            }
                                        }
                                    });

                                    resolve(contractProxy);
                                }).catch(error => reject(error))
                        })
                    }
                }
            }); // Proxy
        }
    }
}

const requestParser = async (_fibos, signargs, httpEndpoint, possibleSigner, chainId) => {

    const fibos = _fibos({httpEndpoint, chainId});

    const contracts = signargs.transaction.actions.map(action => action.account)
        .reduce((acc, contract) => {
            if(!acc.includes(contract)) acc.push(contract);
            return acc;
    }, []);

    const staleAbi = +new Date() - (1000 * 60 * 60 * 24 * 2);
    const abis = {};

    await Promise.all(contracts.map(async contractAccount => {
        const cachedABI = await messageSender(NetworkMessageTypes.ABI_CACHE, {abiContractName:contractAccount, abiGet:true, chainId});

        if(cachedABI === 'object' && cachedABI.timestamp > +new Date((await fibos.getAccount(contractAccount)).last_code_update))
            abis[contractAccount] = fibos.fc.abiCache.abi(contractAccount, cachedABI.abi);

        else {
            abis[contractAccount] = (await fibos.contract(contractAccount)).fc;
            const savableAbi = JSON.parse(JSON.stringify(abis[contractAccount]));
            delete savableAbi.schema;
            delete savableAbi.structs;
            delete savableAbi.types;
            savableAbi.timestamp = +new Date();

            await messageSender(NetworkMessageTypes.ABI_CACHE,
                {abiContractName: contractAccount, abi:savableAbi, abiGet: false, chainId});
        }
    }));

    return await Promise.all(signargs.transaction.actions.map(async (action, index) => {
        const contractAccountName = action.account;

        let abi = abis[contractAccountName];

        const data = abi.fromBuffer(action.name, action.data);
        const actionAbi = abi.abi.actions.find(fcAction => fcAction.name === action.name);
        let ricardian = actionAbi ? actionAbi.ricardian_contract : null;


        if(ricardian){
            const htmlFormatting = {h1:'div class="ricardian-action"', h2:'div class="ricardian-description"'};
            const signer = action.authorization.length === 1 ? action.authorization[0].actor : null;
            ricardian = ricardianParser.parse(action.name, data, ricardian, signer, htmlFormatting);
        }

        return {
            data,
            code:action.account,
            type:action.name,
            authorization:action.authorization,
            ricardian
        };
    }));

}
