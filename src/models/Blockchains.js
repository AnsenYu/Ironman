
export const Blockchains = {
    ENU:'enu',
    ETH:'eth'
};

export const BlockchainsArray =
    Object.keys(Blockchains).map(key => ({key, value:Blockchains[key]}));
