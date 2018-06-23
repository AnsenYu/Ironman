import PluginRepository from '../../plugins/PluginRepository';
import {Blockchains} from '../../models/Blockchains'

export const m5_0_2 = async scatter => {
    const enu = PluginRepository.plugin(Blockchains.ENU);
    const endorsedNetwork = await enu.getEndorsedNetwork();
    if(!scatter.settings.networks.find(network => network.host === endorsedNetwork.host))
        scatter.settings.networks.push(endorsedNetwork);
};
