import { Blockchains } from './Blockchains'

export default class Network {
    constructor(
        _name = '',
        _protocol = 'https',
        _host = 'rpc.enu.one',
        _port = 443,
        blockchain = Blockchains.ENU,
        chainId = '',
        _hostType = 'host',
        _apiUrl = ''
    ) {
        this.name = _name
        this.protocol = _protocol
        this.host = _host
        this.port = _port
        this.blockchain = blockchain
        this.chainId = chainId.toString()

        this.hostType = _hostType
        this.apiUrl = _apiUrl
        console.log('Network this', this)
    }

    static placeholder() {
        return new Network()
    }

    static fromJson(json) {
        const p = Object.assign(Network.placeholder(), json)
        p.chainId = p.chainId ? p.chainId.toString() : ''
        return p
    }

    static fromUnique(netString) {
        const blockchain = netString.split(':')[0]
        if (netString.indexOf(':chain:') > -1) return new Network('', '', '', '', blockchain, netString.replace(`${blockchain}:chain:`, ''))

        const splits = netString.replace(`${blockchain}:`, '').split(':')
        return new Network('', '', splits[0], parseInt(splits[1] || 80), blockchain)
    }

    unique() {
        let approach = ''

        if (this.hostType === 'host') {
            approach = this.chainId.length ? `chain:${this.chainId}-${this.host}:${this.port}` : `${this.host}:${this.port}`
        }

        if (this.hostType === 'api') {
            approach = this.chainId.length ? `chain:${this.chainId}-${this.apiUrl}` : `${this.apiUrl}`
        }

        return `${this.blockchain}:${approach}`.toLowerCase()
    }
    hostport() {
        return `${this.host}${this.port ? ':' : ''}${this.port}`
    }
    getApiUrl() {
        if (this.hostType !== 'api') {
            throw new Error('API URL has not been activated.')

            return null
        }

        return `${this.apiUrl}`
    }
    clone() {
        return Network.fromJson(JSON.parse(JSON.stringify(this)))
    }
    isEmpty() {
        if (this.hostType === 'api') {
            return !this.apiUrl.length
        } else {
            return !this.host.length
        }
    }
    isValid() {
        return (this.host.length && this.port) || this.apiUrl.length || this.chainId.length
    }
}
