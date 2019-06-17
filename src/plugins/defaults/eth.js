import Plugin from '../Plugin'
import * as PluginTypes from '../PluginTypes'
import { Blockchains } from '../../models/Blockchains'
import * as NetworkMessageTypes from '../../messages/NetworkMessageTypes'
import StringHelpers from '../../util/StringHelpers'
import Error from '../../models/errors/Error'
const ProviderEngine = require('web3-provider-engine')
const RpcSubprovider = require('web3-provider-engine/subproviders/rpc')
const WebsocketSubprovider = require('web3-provider-engine/subproviders/websocket')
import HookedWalletSubprovider from 'web3-provider-engine/subproviders/hooked-wallet'
const EthTx = require('ethereumjs-tx')
const ethUtil = require('ethereumjs-util')
import Network from '../../models/Network'
import { IdentityRequiredFields } from '../../models/Identity'
import ObjectHelpers from '../../util/ObjectHelpers'
import { strippedHost } from '../../util/GenericTools'
import IdGenerator from '../../util/IdGenerator'

let messageSender = new WeakMap()
let throwIfNoIdentity = new WeakMap()
let network = new WeakMap()
let web3

const proxy = (dummy, handler) => new Proxy(dummy, handler)

class ScatterEthereumWallet {
    constructor() {
        this.getAccounts = this.getAccounts.bind(this)
        this.signTransaction = this.signTransaction.bind(this)
    }

    async getAccounts(callback) {
        const result = await messageSender(NetworkMessageTypes.IDENTITY_FROM_PERMISSIONS)
        const accounts = !result ? [] : result.accounts.filter(account => account.blockchain === Blockchains.ETH).map(account => account.publicKey)

        callback(null, accounts)
        return accounts
    }

    async signTransaction(transaction) {
        console.log('transaction', transaction)
        if (!network) throw Error.noNetwork()

        // Basic settings
        if (transaction.gas !== undefined) transaction.gasLimit = transaction.gas
        transaction.value = transaction.value || '0x00'
        if (transaction.hasOwnProperty('data')) transaction.data = ethUtil.addHexPrefix(transaction.data)

        // Required Fields
        const requiredFields = IdentityRequiredFields.fromJson(transaction.hasOwnProperty('requiredFields') ? transaction.requiredFields : {})
        if (!requiredFields.isValid()) throw Error.malformedRequiredFields()

        // Contract ABI

        // todo
        const abi = transaction.hasOwnProperty('abi') ? transaction.abi : null
        if (!abi && transaction.hasOwnProperty('data'))
            throw Error.signatureError('no_abi', 'You must provide a JSON ABI along with your transaction so that users can read the contract')

        // Messages for display
        transaction.messages = await messagesBuilder(transaction, abi)

        // Signature Request Popup
        const payload = Object.assign(transaction, { domain: strippedHost(), network, requiredFields })
        const { signatures, returnedFields } = await messageSender(NetworkMessageTypes.REQUEST_SIGNATURE, payload)

        if (transaction.hasOwnProperty('fieldsCallback')) transaction.fieldsCallback(returnedFields)

        return signatures[0]
    }
}

const messagesBuilder = async (transaction, abi) => {
    console.log('transaction', transaction)
    let params = {}
    let methodABI
    if (abi) {
        methodABI = abi.find(method => transaction.data.indexOf(method.signature) !== -1)
        console.log('methodABI', methodABI)
        if (!methodABI)
            throw Error.signatureError('no_abi_method', 'No method signature on the abi you provided matched the data for this transaction')

        const typesArray = methodABI.inputs
        console.log('typesArray', typesArray)
        const hexString = transaction.data.replace(methodABI.signature, '0x')
        console.log('hexString', hexString)

        params = web3.eth.abi.decodeParameters(typesArray, hexString)
        console.log('params 1', params)
        params = Object.keys(params).reduce((acc, key) => {
            if (methodABI.inputs.map(input => input.name).includes(key)) acc[key] = params[key]
            return acc
        }, {})
        console.log('params 2', params)
    }

    const h2n = web3.utils.hexToNumberString

    const data = Object.assign(params, {
        // gas:h2n(transaction.gas),
        gasLimit: h2n(transaction.gasLimit),
        gasPrice: web3.utils.fromWei(h2n(transaction.gasPrice))
    })

    if (transaction.hasOwnProperty('value') && transaction.value > 0) data.value = h2n(transaction.value)

    return [
        {
            data,
            code: transaction.to,
            type: abi ? methodABI.name : 'transfer',
            authorization: transaction.from
        }
    ]
}

const toBuffer = key => ethUtil.toBuffer(ethUtil.addHexPrefix(key))

export default class ETH extends Plugin {
    constructor() {
        super(Blockchains.ETH, PluginTypes.BLOCKCHAIN_SUPPORT)
    }
    accountFormatter(account) {
        return `${account.name}`
    }
    returnableAccount(account) {
        return { publicKey: account.publicKey }
    }

    async getEndorsedNetwork() {
        return new Promise((resolve, reject) => {
            resolve(new Network('ETH Mainnet', 'https', 'ethereum.com', 8080, Blockchains.ETH, '1'))
        })
    }

    async isEndorsedNetwork(network) {
        const endorsedNetwork = await this.getEndorsedNetwork()
        return network.hostport() === endorsedNetwork.hostport() || network.getApiUrl() === endorsedNetwork.hostport()
    }

    accountsAreImported() {
        return false
    }
    privateToPublic(privateKey) {
        return ethUtil.addHexPrefix(ethUtil.privateToAddress(toBuffer(privateKey)).toString('hex'))
    }
    validPrivateKey(privateKey) {
        return ethUtil.isValidPrivate(toBuffer(privateKey))
    }
    validPublicKey(publicKey) {
        return ethUtil.isValidAddress(publicKey)
    }
    randomPrivateKey() {
        return new Promise((resolve, reject) => {
            const byteArray = Array.from({ length: 32 }).map(i => Math.round(IdGenerator.rand() * 255))
            const privateKey = new Buffer(byteArray)
            resolve(privateKey.toString('hex'))
        })
    }
    convertsTo() {
        return [Blockchains.ENU]
    }

    async getBalances(account, network, code = 'enu.token', table = 'accounts') {
        // TODO: Add ability to get ETH balances
        return new Promise(r => {
            r([])
        })
    }

    actionParticipants(payload) {
        return ObjectHelpers.flatten(payload.messages.map(message => message.authorization))
    }

    signer(bgContext, transaction, publicKey, callback, arbitrary = false, isHash = false) {
        bgContext.publicToPrivate(basePrivateKey => {
            if (!basePrivateKey) {
                callback(null)
                return false
            }

            const privateKey = ethUtil.addHexPrefix(basePrivateKey)
            const tx = new EthTx(transaction)
            tx.sign(ethUtil.toBuffer(privateKey))
            const sig = ethUtil.addHexPrefix(tx.serialize().toString('hex'))

            callback(sig)
        }, publicKey)
    }

    signatureProvider(...args) {
        console.log('args', args)
        messageSender = args[0]
        throwIfNoIdentity = args[1]

        return (_network, _web3, _prefix) => {
            console.log('Network11', Network)
            network = Network.fromJson(_network)
            console.log('network', network)
            if (!network.isValid()) throw Error.noNetwork()

            let rpcUrl = ''
            if (network.hostType === 'host') {
                rpcUrl = `${_prefix}://${network.hostport()}`
            } else {
                rpcUrl = `${_prefix}://${network.getApiUrl()}`
            }
            console.log('rpcUrl', rpcUrl)

            const engine = new ProviderEngine()
            web3 = new _web3(engine)

            const walletSubprovider = new HookedWalletSubprovider(new ScatterEthereumWallet())
            engine.addProvider(walletSubprovider)

            console.log("_prefix.indexOf('http')", _prefix.indexOf('http'))
            if (_prefix.indexOf('http') !== -1) engine.addProvider(new RpcSubprovider({ rpcUrl }))
            else engine.addProvider(new WebsocketSubprovider({ rpcUrl }))

            console.log('engine', engine)

            /* engine.on('block', function(block) {
                console.log('================================')
                console.log('BLOCK CHANGED:', '#' + block.number.toString('hex'), '0x' + block.hash.toString('hex'), block)
                console.log('================================')
            })

            // network connectivity error
            engine.on('error', function(err) {
                // report connectivity errors
                console.log('================================')
                console.error('engine error:', err.stack, err)
                console.log('================================')
            })*/

            engine.start()

            return web3

            //
        }
    }
}
