import { describe, expect, it } from 'vitest';
import { imageFactFrom } from './image-service.js';

const SERVICE = 'https://example.org/iiif/image';

describe('imageFactFrom', () => {
  it('reads the live level-2 service’s dimensions and declared sizes', () => {
    expect(
      imageFactFrom(SERVICE, {
        '@context': 'http://iiif.io/api/image/3/context.json',
        id: SERVICE,
        type: 'ImageService3',
        profile: 'level2',
        width: 1335,
        height: 2750,
        maxArea: 3671250,
        sizes: [
          { width: 668, height: 1375 },
          { width: 83, height: 172 },
        ],
      }),
    ).toEqual({
      width: 1335,
      height: 2750,
      sizes: [
        {
          width: 83,
          height: 172,
          url: `${SERVICE}/full/83,172/0/default.jpg`,
        },
        {
          width: 668,
          height: 1375,
          url: `${SERVICE}/full/668,1375/0/default.jpg`,
        },
      ],
      service: { url: SERVICE, type: 'ImageService3', profile: 'level2' },
    });
  });

  it('requests Image API 2 sizes in that version’s canonical form', () => {
    const fact = imageFactFrom(SERVICE, {
      '@context': 'http://iiif.io/api/image/2/context.json',
      '@id': SERVICE,
      profile: ['http://iiif.io/api/image/2/level2.json', { formats: ['png'] }],
      width: 400,
      height: 300,
      sizes: [{ width: 200, height: 150 }],
    });

    expect(fact?.sizes).toEqual([
      { width: 200, height: 150, url: `${SERVICE}/full/200,/0/default.jpg` },
    ]);
    expect(fact?.service).toEqual({
      url: SERVICE,
      type: 'ImageService2',
      profile: 'http://iiif.io/api/image/2/level2.json',
    });
  });

  it('synthesises a master-relative ladder from the tile scale factors', () => {
    const fact = imageFactFrom(SERVICE, {
      type: 'ImageService3',
      profile: 'level1',
      width: 1335,
      height: 2750,
      tiles: [{ width: 512, scaleFactors: [1, 2, 4, 8, 16] }],
    });

    expect(fact?.sizes.map(({ width, height }) => [width, height])).toEqual([
      [83, 172],
      [167, 344],
      [334, 688],
      [668, 1375],
      [1335, 2750],
    ]);
  });

  it('halves down from the master where a service declares no tiles', () => {
    const fact = imageFactFrom(SERVICE, {
      type: 'ImageService3',
      profile: 'level2',
      width: 800,
      height: 600,
    });

    expect(fact?.sizes.map(({ width }) => width)).toEqual([100, 200, 400, 800]);
  });

  it('leaves out synthesised sizes above the server’s declared maximums', () => {
    const fact = imageFactFrom(SERVICE, {
      type: 'ImageService3',
      profile: 'level2',
      width: 800,
      height: 600,
      maxWidth: 400,
    });

    expect(fact?.sizes.map(({ width }) => width)).toEqual([100, 200, 400]);
  });

  it('synthesises nothing for a level-0 service, which only serves what it lists', () => {
    const fact = imageFactFrom(SERVICE, {
      type: 'ImageService3',
      profile: 'level0',
      width: 800,
      height: 600,
    });

    expect(fact?.sizes).toEqual([]);
  });

  it('gives an Image API 1.1 service dimensions but no sizes', () => {
    const fact = imageFactFrom(SERVICE, {
      '@context': 'http://library.stanford.edu/iiif/image-api/1.1/context.json',
      profile:
        'http://library.stanford.edu/iiif/image-api/1.1/compliance.html#level2',
      width: 800,
      height: 600,
    });

    expect(fact?.width).toBe(800);
    expect(fact?.sizes).toEqual([]);
    expect(fact?.service.type).toBe('ImageService1');
  });

  it('leaves out a synthesised rung that rounds to no height', () => {
    const fact = imageFactFrom(SERVICE, {
      type: 'ImageService3',
      profile: 'level2',
      width: 6400,
      height: 10,
      tiles: [{ width: 512, scaleFactors: [1, 32] }],
    });

    expect(fact?.sizes.map(({ width, height }) => [width, height])).toEqual([
      [6400, 10],
    ]);
  });

  it('answers nothing for a document without dimensions', () => {
    expect(imageFactFrom(SERVICE, { type: 'ImageService3' })).toBeUndefined();
    expect(imageFactFrom(SERVICE, null)).toBeUndefined();
  });

  it('answers nothing for fractional dimensions, which are not integers', () => {
    expect(
      imageFactFrom(SERVICE, { width: 1335.5, height: 2750 }),
    ).toBeUndefined();
  });
});
