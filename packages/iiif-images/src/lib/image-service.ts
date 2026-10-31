/** What an image service’s `info.json` tells a consumer, in the consumer’s terms. */
export interface ImageFact {
  readonly width: number;
  readonly height: number;
  /** Renditions to pick from, smallest first. */
  readonly sizes: readonly ImageSize[];
  /** The service itself, for consumers doing deep zoom or region crops. */
  readonly service: {
    readonly url: string;
    readonly type: string;
    readonly profile: string;
  };
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
  readonly url: string;
}

/**
 * An `info.json` as an {@link ImageFact}, or `undefined` where it states no
 * dimensions. `serviceUrl` rather than the document’s own `id` names the service,
 * because that is what the manifest resolved and what a proxied server’s
 * self-reported `id` need not be.
 */
export function imageFactFrom(
  serviceUrl: string,
  info: unknown,
): ImageFact | undefined {
  if (typeof info !== 'object' || info === null) {
    return undefined;
  }
  const document = info as Record<string, unknown>;
  const { width, height } = document;
  if (!isPositive(width) || !isPositive(height)) {
    return undefined;
  }
  const type = serviceTypeOf(document);
  const profile = profileOf(document);
  const isVersion3 = type === 'ImageService3';
  // Image API 1.1 names its qualities differently (`native`, not `default`) and has
  // no `sizes`, and is rare enough that its dimensions alone will do.
  const sizes = (
    type === 'ImageService1' ? [] : sizesOf(document, width, height, profile)
  )
    .sort((left, right) => left.width - right.width)
    .map((size) => ({
      ...size,
      url: `${serviceUrl}/full/${isVersion3 ? `${size.width},${size.height}` : `${size.width},`}/0/default.jpg`,
    }));
  return {
    width,
    height,
    sizes,
    service: { url: serviceUrl, type, profile },
  };
}

/** Rungs below this width are too small to be worth a request. */
const MINIMUM_SYNTHESISED_WIDTH = 64;

function sizesOf(
  document: Record<string, unknown>,
  width: number,
  height: number,
  profile: string,
): { width: number; height: number }[] {
  const declared = Array.isArray(document.sizes)
    ? document.sizes.filter(
        (size): size is { width: number; height: number } =>
          isPositive(size?.width) && isPositive(size?.height),
      )
    : [];
  if (declared.length > 0) {
    return declared.map((size) => ({ width: size.width, height: size.height }));
  }
  // A level-0 server only serves what it lists, so nothing can be asked of it.
  if (/level0/.test(profile)) {
    return [];
  }
  const rungs = new Map<number, { width: number; height: number }>();
  for (const scaleFactor of scaleFactorsOf(document, width)) {
    const rung = {
      width: Math.round(width / scaleFactor),
      height: Math.round(height / scaleFactor),
    };
    if (
      rung.width >= MINIMUM_SYNTHESISED_WIDTH &&
      rung.height >= 1 &&
      isWithinMaximums(rung, document)
    ) {
      rungs.set(rung.width, rung);
    }
  }
  return [...rungs.values()];
}

/** The server’s own precomputed factors where it has tiles, else powers of two. */
function scaleFactorsOf(
  document: Record<string, unknown>,
  width: number,
): number[] {
  const tiles = Array.isArray(document.tiles) ? document.tiles : [];
  const declared = tiles
    .flatMap((tile) =>
      Array.isArray(tile?.scaleFactors) ? tile.scaleFactors : [],
    )
    .filter(isPositive);
  if (declared.length > 0) {
    return declared;
  }
  const factors = [];
  for (
    let factor = 1;
    width / factor >= MINIMUM_SYNTHESISED_WIDTH;
    factor *= 2
  ) {
    factors.push(factor);
  }
  return factors;
}

/**
 * Asking above a declared maximum answers 404, not 400 (Image API 3.0 § 7.3),
 * which would read as a dead link. `maxWidth` alone also bounds the height
 * (§ 5.3), so it is the fallback for a missing `maxHeight`.
 */
function isWithinMaximums(
  rung: { width: number; height: number },
  document: Record<string, unknown>,
): boolean {
  const { maxWidth, maxHeight, maxArea } = document;
  const heightLimit = isPositive(maxHeight) ? maxHeight : maxWidth;
  return (
    (!isPositive(maxWidth) || rung.width <= maxWidth) &&
    (!isPositive(heightLimit) || rung.height <= heightLimit) &&
    (!isPositive(maxArea) || rung.width * rung.height <= maxArea)
  );
}

function serviceTypeOf(document: Record<string, unknown>): string {
  // Only this family: Image API 2 documents commonly say `@type: iiif:Image`, which
  // names what they describe and not the kind of service.
  const type = document.type ?? document['@type'];
  if (typeof type === 'string' && type.startsWith('ImageService')) {
    return type;
  }
  const context = JSON.stringify(document['@context'] ?? '');
  if (context.includes('image/3')) {
    return 'ImageService3';
  }
  if (context.includes('image/2')) {
    return 'ImageService2';
  }
  // A 1.0 document may state no context, so the profile has to answer as well.
  return /image-api|api\/image\/1/.test(`${context} ${profileOf(document)}`)
    ? 'ImageService1'
    : 'ImageService2';
}

/** The compliance level, which Image API 2 states first in an array. */
function profileOf(document: Record<string, unknown>): string {
  const profile = Array.isArray(document.profile)
    ? document.profile[0]
    : document.profile;
  return typeof profile === 'string' ? profile : '';
}

function isPositive(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}
