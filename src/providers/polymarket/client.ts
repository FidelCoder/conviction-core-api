import { MarketSource, MarketStatus } from "@prisma/client";
import { z } from "zod";

import type { MarketProvider, ProviderMarketInput } from "../../services/market-provider.js";

const gammaTagSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  label: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
});

const gammaMarketSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  question: z.string().min(1),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  groupItemTitle: z.string().nullable().optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  archived: z.boolean().optional(),
  endDate: z.string().nullable().optional(),
  endDateIso: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  conditionId: z.string().nullable().optional(),
  questionID: z.string().nullable().optional(),
  clobTokenIds: z.string().nullable().optional(),
  enableOrderBook: z.boolean().optional(),
  acceptingOrders: z.boolean().optional(),
  orderPriceMinTickSize: z.union([z.string(), z.number()]).nullable().optional(),
  orderMinSize: z.union([z.string(), z.number()]).nullable().optional(),
  lastTradePrice: z.union([z.string(), z.number()]).nullable().optional(),
  bestBid: z.union([z.string(), z.number()]).nullable().optional(),
  bestAsk: z.union([z.string(), z.number()]).nullable().optional(),
  icon: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  liquidity: z.union([z.string(), z.number()]).nullable().optional(),
  liquidityClob: z.union([z.string(), z.number()]).nullable().optional(),
  volume: z.union([z.string(), z.number()]).nullable().optional(),
  volume24hr: z.union([z.string(), z.number()]).nullable().optional(),
  volume1wk: z.union([z.string(), z.number()]).nullable().optional(),
  volume1mo: z.union([z.string(), z.number()]).nullable().optional(),
  volume1yr: z.union([z.string(), z.number()]).nullable().optional(),
  oneDayPriceChange: z.union([z.string(), z.number()]).nullable().optional(),
  events: z
    .array(
      z.object({
        icon: z.string().nullable().optional(),
        image: z.string().nullable().optional(),
        slug: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const gammaEventSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  volume: z.union([z.string(), z.number()]).nullable().optional(),
  volume24hr: z.union([z.string(), z.number()]).nullable().optional(),
  volume1wk: z.union([z.string(), z.number()]).nullable().optional(),
  volume1mo: z.union([z.string(), z.number()]).nullable().optional(),
  volume1yr: z.union([z.string(), z.number()]).nullable().optional(),
  liquidity: z.union([z.string(), z.number()]).nullable().optional(),
  markets: z.array(gammaMarketSchema).optional(),
  tags: z.array(gammaTagSchema).optional(),
});

const gammaMarketListSchema = z.array(gammaMarketSchema);
const gammaEventListSchema = z.array(gammaEventSchema);

type GammaMarket = z.infer<typeof gammaMarketSchema>;
type GammaEvent = z.infer<typeof gammaEventSchema>;
type GammaTag = z.infer<typeof gammaTagSchema>;

const discoveryEventLanes = [
  { label: "World Cup", tagIds: ["519", "102232", "102350"], eventLimit: 16, marketLimit: 36, perEventMarketLimit: 7 },
  { label: "Football", tagIds: ["100350", "9545"], eventLimit: 18, marketLimit: 34, perEventMarketLimit: 4 },
  { label: "Sports", tagIds: ["1"], eventLimit: 18, marketLimit: 32, perEventMarketLimit: 3 },
  { label: "Esports", tagIds: ["64"], eventLimit: 12, marketLimit: 24, perEventMarketLimit: 4 },
  { label: "Geopolitics", tagIds: ["100265", "842", "1396"], eventLimit: 12, marketLimit: 28, perEventMarketLimit: 4 },
  { label: "Politics", tagIds: ["2"], eventLimit: 10, marketLimit: 22, perEventMarketLimit: 4 },
  { label: "Crypto", tagIds: ["21"], eventLimit: 12, marketLimit: 28, perEventMarketLimit: 4 },
  { label: "Finance", tagIds: ["120"], eventLimit: 10, marketLimit: 22, perEventMarketLimit: 4 },
  { label: "Tech", tagIds: ["1401"], eventLimit: 8, marketLimit: 18, perEventMarketLimit: 4 },
  { label: "World", tagIds: ["101970"], eventLimit: 10, marketLimit: 22, perEventMarketLimit: 4 },
] as const;

const discoveryKeywordLanes = [
  {
    label: "Africa",
    eventLimit: 260,
    marketLimit: 34,
    perEventMarketLimit: 4,
    terms: [
      "africa",
      "african",
      "afcon",
      "caf ",
      "caf-",
      "cup of nations",
      "nigeria",
      "kenya",
      "ghana",
      "south africa",
      "ethiopia",
      "egypt",
      "morocco",
      "algeria",
      "tunisia",
      "senegal",
      "ivory coast",
      "cote d'ivoire",
      "cameroon",
      "uganda",
      "tanzania",
      "rwanda",
      "zambia",
      "angola",
      "mali",
      "dr congo",
      "lagos",
      "nairobi",
      "johannesburg",
      "cairo",
      "casablanca",
    ],
  },
  {
    label: "Africa World Cup",
    eventLimit: 320,
    marketLimit: 36,
    perEventMarketLimit: 5,
    terms: [
      "africa world cup",
      "african world cup",
      "caf world cup",
      "world cup qualifier",
      "world cup qualification",
      "nigeria world cup",
      "ghana world cup",
      "morocco world cup",
      "senegal world cup",
      "egypt world cup",
      "south africa world cup",
      "cameroon world cup",
    ],
  },
  {
    label: "Global Football",
    eventLimit: 220,
    marketLimit: 44,
    perEventMarketLimit: 5,
    terms: [
      "world cup",
      "fifa",
      "afcon",
      "caf ",
      "champions league",
      "premier league",
      "la liga",
      "serie a",
      "bundesliga",
      "copa america",
      "euros",
      "uefa",
      "football",
      "soccer",
    ],
  },
  {
    label: "Global Sports",
    eventLimit: 180,
    marketLimit: 28,
    perEventMarketLimit: 4,
    terms: ["cricket", "rugby", "formula 1", "f1", "tennis", "ufc", "boxing", "olympics"],
  },
] as const;

type EventCollectionOptions = {
  eventLimit: number;
  marketLimit: number;
  perEventMarketLimit: number;
  seenEventIds: Set<string>;
  keywordTerms?: readonly string[];
};

export class PolymarketProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PolymarketProviderError";
  }
}

export type PolymarketProviderOptions = {
  gammaApiUrl: string;
  listLimit: number;
};

export class PolymarketProvider implements MarketProvider {
  readonly source = MarketSource.POLYMARKET;

  private readonly gammaApiUrl: URL;
  private readonly listLimit: number;

  constructor(options: PolymarketProviderOptions) {
    this.gammaApiUrl = new URL(options.gammaApiUrl);
    this.listLimit = options.listLimit;
  }

  async listMarkets(): Promise<ProviderMarketInput[]> {
    const eventMarkets = await this.listMarketsFromEvents();

    if (eventMarkets.length > 0) {
      return eventMarkets;
    }

    return this.listMarketsDirectly();
  }

  async getMarketById(externalMarketId: string): Promise<ProviderMarketInput | null> {
    const url = this.buildUrl("/markets/" + encodeURIComponent(externalMarketId));

    try {
      const payload = await this.fetchJson(url);
      const parsed = gammaMarketSchema.safeParse(payload);

      if (!parsed.success) {
        throw new PolymarketProviderError(
          "Polymarket market response did not match expected shape",
          {
            cause: parsed.error,
          },
        );
      }

      return mapGammaMarket(parsed.data);
    } catch (error) {
      if (error instanceof PolymarketProviderError && error.message.includes("404")) {
        return null;
      }

      throw error;
    }
  }

  async syncMarket(externalMarketId: string): Promise<ProviderMarketInput | null> {
    return this.getMarketById(externalMarketId);
  }

  private async listMarketsFromEvents() {
    const markets = new Map<string, ProviderMarketInput>();
    const seenEventIds = new Set<string>();

    for (const lane of discoveryEventLanes) {
      if (markets.size >= this.listLimit) {
        break;
      }

      const laneMarketLimit = getScaledLaneMarketLimit(lane.marketLimit, this.listLimit);
      let laneMarketCount = 0;

      for (const tagId of lane.tagIds) {
        if (markets.size >= this.listLimit || laneMarketCount >= laneMarketLimit) {
          break;
        }

        laneMarketCount += await this.collectMarketsFromEvents(
          markets,
          {
            tag_id: tagId,
            related_tags: "true",
          },
          {
            eventLimit: lane.eventLimit,
            marketLimit: laneMarketLimit - laneMarketCount,
            perEventMarketLimit: lane.perEventMarketLimit,
            seenEventIds,
          },
        );
      }
    }

    for (const lane of discoveryKeywordLanes) {
      if (markets.size >= this.listLimit) {
        break;
      }

      const laneMarketLimit = Math.min(
        getScaledLaneMarketLimit(lane.marketLimit, this.listLimit),
        this.listLimit - markets.size,
      );

      await this.collectMarketsFromEvents(
        markets,
        {},
        {
          eventLimit: lane.eventLimit,
          keywordTerms: lane.terms,
          marketLimit: laneMarketLimit,
          perEventMarketLimit: lane.perEventMarketLimit,
          seenEventIds,
        },
      );
    }

    if (markets.size < this.listLimit) {
      await this.collectMarketsFromEvents(markets, {}, {
        eventLimit: this.listLimit,
        marketLimit: this.listLimit - markets.size,
        perEventMarketLimit: 5,
        seenEventIds,
      });
    }

    return Array.from(markets.values());
  }

  private async collectMarketsFromEvents(
    markets: Map<string, ProviderMarketInput>,
    extraParams: Record<string, string>,
    options: EventCollectionOptions,
  ) {
    const pageSize = Math.min(50, Math.max(10, options.eventLimit));
    let addedMarkets = 0;
    let scannedEvents = 0;

    for (
      let offset = 0;
      markets.size < this.listLimit && scannedEvents < options.eventLimit && addedMarkets < options.marketLimit;
      offset += pageSize
    ) {
      const remainingEvents = options.eventLimit - scannedEvents;
      const url = this.buildUrl("/events", {
        active: "true",
        closed: "false",
        archived: "false",
        limit: String(Math.min(pageSize, remainingEvents)),
        offset: String(offset),
        order: "volume_24hr",
        ascending: "false",
        ...extraParams,
      });
      const payload = await this.fetchJson(url);
      const parsed = gammaEventListSchema.safeParse(payload);

      if (!parsed.success) {
        throw new PolymarketProviderError(
          "Polymarket event list response did not match expected shape",
          { cause: parsed.error },
        );
      }

      if (parsed.data.length === 0) {
        break;
      }

      for (const event of parsed.data) {
        scannedEvents += 1;

        if (options.keywordTerms && !eventMatchesTerms(event, options.keywordTerms)) {
          if (scannedEvents >= options.eventLimit) {
            break;
          }

          continue;
        }

        if (options.seenEventIds.has(event.id)) {
          continue;
        }

        options.seenEventIds.add(event.id);
        addedMarkets += addEventMarkets(
          markets,
          event,
          Math.min(options.perEventMarketLimit, options.marketLimit - addedMarkets),
          this.listLimit,
        );

        if (markets.size >= this.listLimit || scannedEvents >= options.eventLimit || addedMarkets >= options.marketLimit) {
          break;
        }
      }

      if (parsed.data.length < pageSize) {
        break;
      }
    }

    return addedMarkets;
  }

  private async listMarketsDirectly() {
    const url = this.buildUrl("/markets", {
      active: "true",
      closed: "false",
      limit: String(this.listLimit),
      order: "volume_24hr",
      ascending: "false",
    });
    const payload = await this.fetchJson(url);
    const parsed = gammaMarketListSchema.safeParse(payload);

    if (!parsed.success) {
      throw new PolymarketProviderError(
        "Polymarket market list response did not match expected shape",
        {
          cause: parsed.error,
        },
      );
    }

    return parsed.data.map((market) => mapGammaMarket(market)).filter(isTradableMarket);
  }

  private buildUrl(pathname: string, params: Record<string, string> = {}) {
    const url = new URL(pathname, this.gammaApiUrl);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return url;
  }

  private async fetchJson(url: URL): Promise<unknown> {
    let response: Response;

    try {
      response = await fetch(url);
    } catch (error) {
      throw new PolymarketProviderError("Failed to reach Polymarket Gamma API at " + url.origin, {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new PolymarketProviderError(
        "Polymarket Gamma API request failed with " + response.status + " " + response.statusText,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new PolymarketProviderError("Polymarket Gamma API returned invalid JSON", {
        cause: error,
      });
    }
  }
}

export function mapGammaMarket(market: GammaMarket, event?: GammaEvent): ProviderMarketInput {
  const [yesTokenId, noTokenId] = parseTokenIds(market.clobTokenIds);
  const slug = market.slug ?? event?.slug ?? null;
  const volume24hr = firstDefined(market.volume24hr, event?.volume24hr);
  const volume1wk = firstDefined(market.volume1wk, event?.volume1wk);
  const volume1mo = firstDefined(market.volume1mo, event?.volume1mo);
  const volume1yr = firstDefined(market.volume1yr, event?.volume1yr);
  const totalVolume = firstDefined(market.volume, event?.volume);
  const liquidity = firstDefined(market.liquidityClob, market.liquidity, event?.liquidity);
  const tagLabels = getTagLabels(event?.tags);
  const tagSlugs = getTagSlugs(event?.tags);
  const primaryTag = getPrimaryEventTag(market, event, tagLabels, tagSlugs);
  const imageUrl = firstDefined(market.image, event?.image, market.events?.[0]?.image, null);
  const iconUrl = firstDefined(market.icon, event?.icon, market.events?.[0]?.icon, null);
  const discoveryRegion = inferDiscoveryRegion(market, event, tagLabels, tagSlugs);
  const discoveryTopics = inferDiscoveryTopics(market, event, tagLabels, tagSlugs, primaryTag);
  const metadata = buildMarketMetadata({
    discoveryRegion,
    discoveryTopics,
    eventSlug: event?.slug ?? null,
    eventTitle: event?.title ?? null,
    groupItemTitle: market.groupItemTitle ?? null,
    iconUrl,
    imageUrl,
    liquidity,
    oneDayPriceChange: market.oneDayPriceChange,
    primaryTag,
    tagLabels,
    tagSlugs,
    totalVolume,
    volume1mo,
    volume1wk,
    volume1yr,
    volume24hr,
  });

  return {
    externalMarketId: market.id,
    source: MarketSource.POLYMARKET,
    title: market.question,
    description: market.description ?? null,
    category: getMarketCategory(market, event, primaryTag),
    status: mapMarketStatus(market),
    resolutionDate: parseDate(market.endDate ?? market.endDateIso),
    externalUrl: slug ? "https://polymarket.com/market/" + slug : null,
    yesTokenId,
    noTokenId,
    slug,
    conditionId: market.conditionId ?? null,
    questionId: market.questionID ?? null,
    orderBookEnabled: market.enableOrderBook ?? false,
    acceptingOrders: market.acceptingOrders ?? false,
    orderPriceMinTickSize: market.orderPriceMinTickSize ?? null,
    orderMinSize: market.orderMinSize ?? null,
    lastTradePrice: market.lastTradePrice ?? null,
    bestBid: market.bestBid ?? null,
    bestAsk: market.bestAsk ?? null,
    providerMetadata: metadata,
  };
}

function mapMarketStatus(
  market: Pick<GammaMarket, "active" | "archived" | "closed">,
): MarketStatus {
  if (market.archived) {
    return MarketStatus.CANCELLED;
  }

  if (market.closed) {
    return MarketStatus.CLOSED;
  }

  if (market.active) {
    return MarketStatus.ACTIVE;
  }

  return MarketStatus.CLOSED;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTokenIds(value: string | null | undefined): [string | null, string | null] {
  if (!value) {
    return [null, null];
  }

  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return [null, null];
    }

    const [yesTokenId, noTokenId] = parsed;

    return [
      typeof yesTokenId === "string" ? yesTokenId : null,
      typeof noTokenId === "string" ? noTokenId : null,
    ];
  } catch {
    return [null, null];
  }
}

function firstDefined<TValue>(...values: Array<TValue | null | undefined>) {
  return values.find((value) => value !== null && typeof value !== "undefined") ?? null;
}

function getMarketCategory(market: GammaMarket, event?: GammaEvent, primaryTag?: string | null) {
  return primaryTag ?? market.category ?? getFirstTagLabel(event?.tags) ?? event?.title ?? market.events?.[0]?.title ?? null;
}

function isTradableMarket(market: ProviderMarketInput) {
  return market.status === MarketStatus.ACTIVE && Boolean(market.yesTokenId);
}

function addEventMarkets(
  markets: Map<string, ProviderMarketInput>,
  event: GammaEvent,
  perEventMarketLimit: number,
  totalMarketLimit: number,
) {
  let addedFromEvent = 0;

  for (const market of getRankedEventMarkets(event)) {
    if (perEventMarketLimit <= 0) {
      break;
    }

    const mapped = mapGammaMarket(market, event);

    if (!isTradableMarket(mapped) || markets.has(mapped.externalMarketId)) {
      continue;
    }

    markets.set(mapped.externalMarketId, mapped);
    addedFromEvent += 1;

    if (addedFromEvent >= perEventMarketLimit || markets.size >= totalMarketLimit) {
      break;
    }
  }

  return addedFromEvent;
}

function eventMatchesTerms(event: GammaEvent, terms: readonly string[]) {
  return matchesAny(getEventSearchText(event), terms);
}

function getEventSearchText(event: GammaEvent) {
  const tagLabels = getTagLabels(event.tags);
  const tagSlugs = getTagSlugs(event.tags);
  const marketText = (event.markets ?? [])
    .map((market) => [market.question, market.description, market.category, market.groupItemTitle].filter(Boolean).join(" "))
    .join(" ");

  return [event.title, event.slug, marketText, ...tagLabels, ...tagSlugs].filter(Boolean).join(" ").toLowerCase();
}

function getScaledLaneMarketLimit(baseLimit: number, totalLimit: number) {
  return Math.max(4, Math.ceil((baseLimit / 250) * totalLimit));
}

function getRankedEventMarkets(event: GammaEvent) {
  return [...(event.markets ?? [])].sort((left, right) => getGammaMarketScore(right) - getGammaMarketScore(left));
}

function getGammaMarketScore(market: GammaMarket) {
  return (
    Number(firstDefined(market.volume24hr, market.volume1wk, market.volume1mo, market.volume1yr, market.volume) ?? 0) +
    Number(firstDefined(market.liquidityClob, market.liquidity) ?? 0) / 100
  );
}

function buildMarketMetadata(input: {
  discoveryRegion: string | null;
  discoveryTopics: string[];
  eventSlug: string | null;
  eventTitle: string | null;
  groupItemTitle: string | null;
  iconUrl: string | null;
  imageUrl: string | null;
  liquidity: string | number | null;
  oneDayPriceChange: string | number | null | undefined;
  primaryTag: string | null;
  tagLabels: string[];
  tagSlugs: string[];
  totalVolume: string | number | null;
  volume1mo: string | number | null;
  volume1wk: string | number | null;
  volume1yr: string | number | null;
  volume24hr: string | number | null;
}) {
  const metadata = {
    discoveryRegion: input.discoveryRegion,
    discoveryTopics: input.discoveryTopics,
    eventSlug: input.eventSlug,
    eventTitle: input.eventTitle,
    groupItemTitle: input.groupItemTitle,
    iconUrl: input.iconUrl,
    imageUrl: input.imageUrl,
    liquidity: normalizeNumericString(input.liquidity),
    oneDayPriceChange: normalizeNumericString(input.oneDayPriceChange),
    primaryTag: input.primaryTag,
    tagLabels: input.tagLabels,
    tagSlugs: input.tagSlugs,
    totalVolume: normalizeNumericString(input.totalVolume),
    volume1mo: normalizeNumericString(input.volume1mo),
    volume1wk: normalizeNumericString(input.volume1wk),
    volume1yr: normalizeNumericString(input.volume1yr),
    volume24hr: normalizeNumericString(input.volume24hr),
  };

  return JSON.stringify(metadata);
}

function normalizeNumericString(value: string | number | null | undefined) {
  if (value === null || typeof value === "undefined") return null;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? String(parsed) : null;
}

function getTagLabels(tags: GammaTag[] | undefined) {
  return getDedupeTags(tags, "label");
}

function getTagSlugs(tags: GammaTag[] | undefined) {
  return getDedupeTags(tags, "slug");
}

function getDedupeTags(tags: GammaTag[] | undefined, key: "label" | "slug") {
  return Array.from(
    new Set(
      (tags ?? [])
        .map((tag) => tag[key]?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function getFirstTagLabel(tags: GammaTag[] | undefined) {
  return getTagLabels(tags)[0] ?? null;
}

function inferDiscoveryTopics(
  market: GammaMarket,
  event: GammaEvent | undefined,
  tagLabels: string[],
  tagSlugs: string[],
  primaryTag: string | null,
) {
  const text = getMarketSearchText(market, event, tagLabels, tagSlugs);
  const topics = new Set<string>();

  if (primaryTag) topics.add(primaryTag);
  if (matchesAny(text, ["afcon", "caf ", "caf-", "africa cup of nations", "cup of nations"])) {
    topics.add("African Football");
    topics.add("Sports");
  }
  if (matchesAny(text, ["world cup", "fifa", "world cup qualifier", "world cup qualification"])) {
    topics.add("World Cup");
    topics.add("Sports");
  }
  if (matchesAny(text, ["football", "soccer", "champions league", "premier league", "la liga", "serie a", "bundesliga", "uefa"])) {
    topics.add("Football");
    topics.add("Sports");
  }
  if (matchesAny(text, ["cricket"])) {
    topics.add("Cricket");
    topics.add("Sports");
  }
  if (matchesAny(text, ["rugby"])) {
    topics.add("Rugby");
    topics.add("Sports");
  }
  if (matchesAny(text, ["esports", "counter-strike", "cs2", "league of legends", "valorant", "dota"])) topics.add("Esports");
  if (matchesAny(text, ["crypto", "bitcoin", "btc", "ethereum", "solana", "airdrop"])) topics.add("Crypto");
  if (matchesAny(text, ["geopolitics", "nato", "hormuz", "gaza", "iran", "russia", "ukraine", "taiwan"])) topics.add("Geopolitics");
  if (matchesAny(text, ["election", "elections", "politics", "president", "parliament", "government"])) topics.add("Politics");
  if (matchesAny(text, ["finance", "business", "earnings", "ipo", "stocks", "fed", "rates"])) topics.add("Finance");
  if (matchesAny(text, ["tech", "technology", "openai", " ai ", "nvidia", "startup"])) topics.add("Tech");
  if (matchesAny(text, ["weather", "hurricane", "temperature", "rain", "flood", "wildfire"])) topics.add("Weather");
  if (matchesAny(text, ["culture", "pop culture", "movie", "music", "album", "celebrity"])) topics.add("Culture");

  return Array.from(topics);
}

function inferDiscoveryRegion(
  market: GammaMarket,
  event: GammaEvent | undefined,
  tagLabels: string[],
  tagSlugs: string[],
) {
  const text = getMarketSearchText(market, event, tagLabels, tagSlugs);

  if (matchesAny(text, ["crypto", "bitcoin", "ethereum", "airdrop", "token", "defi", "solana", "onchain", "on-chain"])) {
    return "Crypto-native";
  }

  if (matchesAny(text, ["israel", "hamas", "iran", "saudi", "uae", "qatar", "gaza", "middle east", "palestine", "abraham accords"])) return "Middle East";
  if (matchesAny(text, [
    "africa",
    "african",
    "afcon",
    "caf ",
    "caf-",
    "nigeria",
    "kenya",
    "ghana",
    "south africa",
    "ethiopia",
    "egypt",
    "morocco",
    "algeria",
    "tunisia",
    "senegal",
    "ivory coast",
    "cote d'ivoire",
    "cameroon",
    "uganda",
    "tanzania",
    "rwanda",
    "zambia",
    "angola",
    "mali",
    "dr congo",
    "lagos",
    "nairobi",
    "johannesburg",
    "cairo",
    "casablanca",
  ])) return "Africa";
  if (matchesAny(text, ["china", "india", "japan", "korea", "singapore", "taiwan", "asia", "indonesia", "pakistan", "bangladesh"])) return "Asia";
  if (matchesAny(text, ["uk", "britain", "london", "europe", "eu ", "france", "germany", "spain", "italy", "russia", "ukraine"])) return "Europe";
  if (matchesAny(text, ["brazil", "argentina", "mexico", "colombia", "chile", "latin america", "latam"])) return "Latin America";
  if (matchesAny(text, ["nba", "nfl", "mlb", "new york", "san antonio", "oklahoma", "vegas", "u.s.", "usa", "america", "united states"])) return "United States";

  return "Global";
}

function getPrimaryEventTag(
  market: GammaMarket,
  event: GammaEvent | undefined,
  tagLabels: string[],
  tagSlugs: string[],
) {
  const text = getMarketSearchText(market, event, tagLabels, tagSlugs);

  if (matchesAny(text, ["afcon", "caf ", "caf-", "africa cup of nations", "cup of nations"])) return "African Football";
  if (matchesAny(text, ["world cup", "fifa world cup", "2026-fifa-world-cup", "fifa-world-cup"])) return "World Cup";
  if (matchesAny(text, ["football", "soccer", "champions league", "premier league", "la liga", "serie a", "bundesliga", "uefa"])) return "Football";
  if (matchesAny(text, ["esports", "counter-strike", "cs2", "league of legends", "valorant", "dota"])) return "Esports";
  if (matchesAny(text, ["geopolitics", "foreign affairs", "international affairs", "nato", "hormuz"])) return "Geopolitics";
  if (matchesAny(text, ["crypto", "bitcoin", "btc", "ethereum", "solana", "airdrop"])) return "Crypto";
  if (matchesAny(text, ["finance", "business", "earnings", "ipo", "stocks", "fed", "rates"])) return "Finance";
  if (matchesAny(text, ["election", "elections", "politics", "president", "parliament", "government"])) return "Politics";
  if (matchesAny(text, ["tech", "technology", "openai", " ai ", "nvidia", "startup"])) return "Tech";
  if (matchesAny(text, ["weather", "hurricane", "temperature", "rain", "flood", "wildfire"])) return "Weather";
  if (matchesAny(text, ["culture", "pop culture", "movie", "music", "album", "celebrity"])) return "Culture";
  if (matchesAny(text, ["economy", "inflation", "gdp", "recession", "tariff"])) return "Economy";
  if (matchesAny(text, ["sports", "soccer", "nba", "nfl", "mlb", "nhl", "cricket", "ufc"])) return "Sports";

  return null;
}

function getMarketSearchText(
  market: GammaMarket,
  event: GammaEvent | undefined,
  tagLabels: string[],
  tagSlugs: string[],
) {
  return [
    market.question,
    market.category,
    market.description,
    market.groupItemTitle,
    market.slug,
    event?.title,
    event?.slug,
    ...tagLabels,
    ...tagSlugs,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchesAny(text: string, terms: readonly string[]) {
  const normalizedText = text.toLowerCase();

  return terms.some((term) => {
    const normalizedTerm = term.toLowerCase().trim();

    if (!normalizedTerm) return false;

    if (/^[a-z0-9]+$/i.test(normalizedTerm)) {
      return new RegExp("\\b" + escapeRegExp(normalizedTerm) + "\\b", "i").test(normalizedText);
    }

    return normalizedText.includes(normalizedTerm);
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
