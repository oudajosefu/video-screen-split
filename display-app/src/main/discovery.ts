import { Bonjour } from "bonjour-service";

const SERVICE_TYPE = "video-screen-split";

export interface DiscoveredCoordinator {
  host: string;
  port: number;
}

/**
 * Resolve coordinator location via mDNS. Resolves with the first matching
 * service found, or rejects after `timeoutMs` if none.
 */
export function discoverCoordinator(
  timeoutMs = 10_000,
): Promise<DiscoveredCoordinator> {
  return new Promise((resolve, reject) => {
    const bonjour = new Bonjour();
    let done = false;

    const finish = (result: DiscoveredCoordinator | Error) => {
      if (done) return;
      done = true;
      browser.stop();
      bonjour.destroy();
      result instanceof Error ? reject(result) : resolve(result);
    };

    const browser = bonjour.find({ type: SERVICE_TYPE }, (service) => {
      const host = service.referer?.address ?? service.host;
      if (host && service.port) {
        finish({ host, port: service.port });
      }
    });

    setTimeout(() => finish(new Error("coordinator discovery timed out")), timeoutMs);
  });
}
