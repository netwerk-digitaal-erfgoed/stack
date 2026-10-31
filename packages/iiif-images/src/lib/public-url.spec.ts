import { describe, expect, it } from 'vitest';
import { isPublicWebUrl } from './public-url.js';

describe('isPublicWebUrl', () => {
  it.each([
    'https://example.org/iiif/manifest.json',
    'http://example.org/iiif/manifest.json',
    'https://n2t.net/ark:/50282/CBB6/iiif.json',
    'https://demo.limb-gallery.com/i/?IIIF=/7b/image.tif',
    'https://8.8.8.8/manifest',
    'https://[2606:4700:4700::1111]/manifest',
  ])('allows %s', (url) => {
    expect(isPublicWebUrl(url)).toBe(true);
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.org/manifest',
    'not a url',
    'http://127.0.0.1/manifest',
    'http://2130706433/manifest',
    'http://10.0.0.5/manifest',
    'http://172.16.0.1/manifest',
    'http://192.168.1.1/manifest',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/manifest',
    'http://[::1]/manifest',
    'http://[::ffff:127.0.0.1]/manifest',
    'http://[fe80::1]/manifest',
    'http://[fd00::1]/manifest',
    'http://localhost/manifest',
    'http://typesense:8108/collections',
    'http://search-api.default.svc/graphql',
    'http://search-api.default.svc.cluster.local/graphql',
    'http://metadata.google.internal/computeMetadata',
  ])('rejects %s', (url) => {
    expect(isPublicWebUrl(url)).toBe(false);
  });
});
