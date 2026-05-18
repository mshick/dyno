import https from 'node:https';
import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import type { TranslateConfig } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { REGION } from './constants.ts';

export function getClientConfig(config: DynamoDBClientConfig): DynamoDBClientConfig {
  return {
    maxAttempts: 6,
    requestHandler: new NodeHttpHandler({
      // Disabled due to timeouts with SSG — effectively no connectionTimeout
      // connectionTimeout: 1000,
      requestTimeout: 5000,
      httpsAgent: new https.Agent({
        // Set this explicitly, since we provide an agent, we can't rely on defaults
        keepAlive: true,
        maxSockets: 400, // default is 50
      }),
    }),
    region: REGION,
    ...config,
  };
}

export function getClientTranslateConfig(config?: TranslateConfig): TranslateConfig {
  return {
    marshallOptions: {
      removeUndefinedValues: true,
      ...config?.marshallOptions,
    },
    unmarshallOptions: {
      ...config?.unmarshallOptions,
    },
  };
}
