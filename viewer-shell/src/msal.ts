import { ConfidentialClientApplication } from '@azure/msal-node';
import type { AuthCodeClient } from './auth.js';
import type { EntraConfig } from './config.js';

/** The only file that touches @azure/msal-node. Secrets come from env via config; nothing is logged. */
export function createMsalClient(entra: EntraConfig): AuthCodeClient {
  return new ConfidentialClientApplication({
    auth: {
      clientId: entra.clientId,
      authority: `https://login.microsoftonline.com/${entra.tenantId}`,
      clientSecret: entra.clientSecret,
    },
  });
}
