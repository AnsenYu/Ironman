
export const Blockchains = {
    EOS:'eos',
    ENU:'enu',
    FIBOS:'fibos',
    ETH:'eth'
};

export const BlockchainsArray =
    Object.keys(Blockchains).map(key => ({key, value:Blockchains[key]}));
