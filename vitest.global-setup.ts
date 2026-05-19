import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { down, type IDockerComposeOptions, upAll } from 'docker-compose';
import { loadEnv } from 'vite';
import type { TestProject } from 'vitest/node';
import { killConnection, waitForConnection } from './src/table.ts';

const DOCKER_PROJECT_NAME = 'mshick-dyno-vitest';
const DOCKER_COMPOSE_FILE = 'docker-compose.yml';

const dirname = import.meta.dirname;

let dockerConfig: IDockerComposeOptions | undefined;

export default async function setup(_project: TestProject) {
  const env = {
    ...process.env,
    ...loadEnv('test', dirname, ''),
  };

  dockerConfig = {
    cwd: dirname,
    config: DOCKER_COMPOSE_FILE,
    composeOptions: ['--project-name', DOCKER_PROJECT_NAME],
  };

  console.info('Starting Docker container for tests...');
  await upAll(dockerConfig);

  if (!env.DYNAMO_DB_REGION || !env.DYNAMO_DB_ENDPOINT) {
    throw new Error('DynamoDB region and endpoint must be set');
  }

  let dynamoConnection: DynamoDB | undefined;

  if (dockerConfig) {
    dynamoConnection = new DynamoDB({
      region: env.DYNAMO_DB_REGION,
      endpoint: env.DYNAMO_DB_ENDPOINT,
    });

    console.info('Waiting for DynamoDB to be ready...');
    await waitForConnection(dynamoConnection, { stabilizeDelay: 2000, maxDelay: 60000 });
  }

  return async () => {
    if (dynamoConnection) {
      killConnection(dynamoConnection);
    }

    if (dockerConfig) {
      await down(dockerConfig);
    }
  };
}

process.on('exit', () => {
  if (dockerConfig) {
    void down(dockerConfig);
  }
});
