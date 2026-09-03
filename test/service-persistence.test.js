import fs from 'node:fs';
import path from 'node:path';
import {
  startInMemoryStorachaService,
  stopInMemoryStorachaService,
} from './helpers/in-memory-storacha.js';

describe('Storacha In-memory Service Persistence', () => {
  const signerPath = path.resolve('.tmp/test-service-did.json');

  beforeEach(() => {
    if (fs.existsSync(signerPath)) {
      fs.unlinkSync(signerPath);
    }
  });

  afterAll(async () => {
    if (fs.existsSync(signerPath)) {
      fs.unlinkSync(signerPath);
    }
    try {
      const tmpDir = path.dirname(signerPath);
      if (fs.readdirSync(tmpDir).length === 0) {
        fs.rmdirSync(tmpDir);
      }
    } catch {
      // best-effort: a non-empty .tmp dir is fine to leave behind
    }
  });

  it('should reuse the same service DID key when persistence is enabled', async () => {
    const service1 = await startInMemoryStorachaService({
      persistServiceDid: true,
      serviceDidPath: signerPath,
    });
    const key1 = service1.context.id.toDIDKey();
    const did1 = service1.context.id.did();
    await stopInMemoryStorachaService(service1);

    const service2 = await startInMemoryStorachaService({
      persistServiceDid: true,
      serviceDidPath: signerPath,
    });
    const key2 = service2.context.id.toDIDKey();
    const did2 = service2.context.id.did();
    await stopInMemoryStorachaService(service2);

    expect(did1).toBe(did2);
    expect(key1).toBe(key2);
    expect(fs.existsSync(signerPath)).toBe(true);
  });

  it('should rotate DID key by default (persistence disabled)', async () => {
    const service1 = await startInMemoryStorachaService();
    const key1 = service1.context.id.toDIDKey();
    await stopInMemoryStorachaService(service1);

    const service2 = await startInMemoryStorachaService();
    const key2 = service2.context.id.toDIDKey();
    await stopInMemoryStorachaService(service2);

    expect(key1).not.toBe(key2);
  });

  it('should rotate DID key when persistence is disabled even if path is provided', async () => {
    const service1 = await startInMemoryStorachaService({
      persistServiceDid: false,
      serviceDidPath: signerPath,
    });
    const key1 = service1.context.id.toDIDKey();
    await stopInMemoryStorachaService(service1);

    const service2 = await startInMemoryStorachaService({
      persistServiceDid: false,
      serviceDidPath: signerPath,
    });
    const key2 = service2.context.id.toDIDKey();
    await stopInMemoryStorachaService(service2);

    expect(key1).not.toBe(key2);
  });
});
