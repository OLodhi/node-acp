import { createAcpxRemoteService } from "./service.js";

const plugin = {
  id: "acpx-remote",
  name: "Remote ACP Sessions",
  register(api: any) {
    api.registerService(createAcpxRemoteService(api));
  },
};

export default plugin;
