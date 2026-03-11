import prisma from '@/lib/db'
import { buildImageContext } from '@/lib/image-context'
import { getCliAvailability, claudePrompt, modelNameToCliAlias } from '@/lib/claude-cli-auth'
import { getCodexCliAvailability, codexPrompt } from '@/lib/codex-cli'
import { getActiveModel, getProvider } from '@/lib/settings'
import { AIClient, resolveAIClient } from '@/lib/ai-client'

const BATCH_SIZE = 20

const DEFAULT_CATEGORIES = [
  {
    name: 'AI & Agents',
    slug: 'ai-resources',
    color: '#8b5cf6',
    description:
      'AI models, LLMs, Claude, Gemini, AI agents, agentic workflows, MCP, RAG, prompt engineering, fine-tuning, AI tooling, automation via AI, multimodal, AI startups, AI safety, model benchmarks — anything where AI is the primary subject',
    isAiGenerated: false,
  },
  {
    name: 'Crypto & Web3',
    slug: 'finance-crypto',
    color: '#f59e0b',
    description:
      'Bitcoin, Ethereum, Solana, DeFi, NFTs, on-chain analytics, crypto trading, altcoins, airdrops, memecoins, Web3 development, smart contracts, DAOs, Layer 2, wallets, tokenomics, blockchain infrastructure',
    isAiGenerated: false,
  },
  {
    name: 'Dev & Engineering',
    slug: 'dev-tools',
    color: '#06b6d4',
    description:
      'Software engineering, coding, GitHub, open source, APIs, databases, DevOps, system design, backend, frontend, TypeScript, Python, Rust, Go, Vercel, Supabase, Docker, CLI tools, developer workflows, debugging, architecture patterns',
    isAiGenerated: false,
  },
  {
    name: 'Security & Privacy',
    slug: 'security-privacy',
    color: '#ef4444',
    description:
      'Cybersecurity, hacking, exploits, OPSEC, privacy tools, VPNs, encryption, threat intelligence, phishing, malware, zero-days, pen testing, CTF, data breaches, authentication, identity, browser privacy, surveillance',
    isAiGenerated: false,
  },
  {
    name: 'Business & Growth',
    slug: 'startups-business',
    color: '#f97316',
    description:
      'Startups, founders, SaaS, product-market fit, fundraising, VC, marketing, growth, sales, revenue, bootstrapping, SEO, audience building, personal brand, content strategy, distribution, X/Twitter growth tactics',
    isAiGenerated: false,
  },
  {
    name: 'PKM & Workflows',
    slug: 'productivity',
    color: '#a855f7',
    description:
      'Personal knowledge management, Obsidian, second brain, note-taking systems, automation, workflows, mental models, deep work, focus, habit systems, tools for thought, life operating systems, delegation, time design',
    isAiGenerated: false,
  },
  {
    name: 'Health & Performance',
    slug: 'health-wellness',
    color: '#14b8a6',
    description:
      'Fitness, nutrition, longevity, biohacking, sleep optimisation, cognitive performance, supplements, strength training, stress, meditation, gut health, lab results, wearables like Whoop and Oura, mental clarity',
    isAiGenerated: false,
  },
  {
    name: 'Science & Ideas',
    slug: 'science-research',
    color: '#3b82f6',
    description:
      'Scientific research, papers, physics, biology, neuroscience, space, quantum computing, emerging tech, robotics, futurism, philosophy, big ideas, intellectual frameworks, contrarian thinking, long-form essays',
    isAiGenerated: false,
  },
  {
    name: 'Macro & Finance',
    slug: 'macro-finance',
    color: '#10b981',
    description:
      'Macroeconomics, Federal Reserve, interest rates, inflation, global markets, equities, commodities, forex, bonds, geopolitical risk, monetary policy, fiscal policy, central banks, market cycles, recession signals, economic data — NOT crypto',
    isAiGenerated: false,
  },
  {
    name: 'General',
    slug: 'general',
    color: '#64748b',
    description: "Miscellaneous content — memes, jokes, satire, entertainment, or anything that doesn't clearly fit another category",
    isAiGenerated: false,
  },
] as const

// Default slugs only used for seeding — all runtime categorization uses DB slugs
const DEFAULT_SLUGS = DEFAULT_CATEGORIES.map((c) => c.slug)

interface BookmarkForCategorization {
  tweetId: string
  text: string
  imageTags?: string
  semanticTags?: string[]
  hashtags?: string[]
  tools?: string[]
}

interface CategoryAssignment {
  category: string
  confidence: number
}

interface CategorizationResult {
  tweetId: string
  assignments: CategoryAssignment[]
}

export async function seedDefaultCategories(): Promise<void> {
  const existing = await prisma.category.findMany({ select: { slug: true } })
  const existingSlugs = new Set(existing.map((c) => c.slug))

  for (const cat of DEFAULT_CATEGORIES) {
    if (existingSlugs.has(cat.slug)) {
      // Sync name, color, and description so renames/updates propagate to existing DBs
      await prisma.category.update({
        where: { slug: cat.slug },
        data: { name: cat.name, color: cat.color, description: cat.description },
      })
    } else {
      await prisma.category.create({ data: { ...cat } })
    }
  }
}

function buildCategorizationPrompt(
  bookmarks: BookmarkForCategorization[],
  categoryDescriptions: Record<string, string>,
  allSlugs: string[],
): string {
  const categoriesList = allSlugs.map(
    (slug) => `- ${slug}: ${categoryDescriptions[slug] ?? slug.replace(/-/g, ' ')}`,
  ).join('\n')

  const tweetData = bookmarks.map((b) => {
    const entry: Record<string, unknown> = { id: b.tweetId, text: b.text.slice(0, 400) }
    const imgCtx = buildImageContext(b.imageTags)
    if (imgCtx) entry.images = imgCtx
    if (b.semanticTags?.length) entry.aiTags = b.semanticTags.slice(0, 20).join(', ')
    if (b.hashtags?.length) entry.hashtags = b.hashtags.slice(0, 10).join(', ')
    if (b.tools?.length) entry.tools = b.tools.join(', ')
    return entry
  })

  return `You are an expert librarian categorizing Twitter/X bookmarks into a personal knowledge base. Your categorizations directly power search and discovery — accuracy is critical.

AVAILABLE CATEGORIES:
${categoriesList}

CATEGORIZATION RULES:
- Assign 1-3 categories per bookmark — only what CLEARLY applies
- Confidence 0.5-1.0: use 0.9+ for obvious fits, 0.6-0.8 for plausible, 0.5 for borderline
- Priority: specific categories beat "general" — only use "general" when truly nothing else fits
- Use ALL signals: tweet text, image analysis, OCR text inside images, hashtags, detected tools, semantic AI tags

SIGNAL WEIGHTING (use all, not just text):
- Image shows financial chart, price action, wallet UI → finance-crypto (even if tweet text is vague)
- Image shows code, terminal, GitHub, a dev tool UI → dev-tools
- Image is clearly a meme format or labeled as humor/satire → funny-memes with high confidence
- Tools field mentions GitHub/Vercel/React/etc → dev-tools likely applies
- aiTags field is pre-computed context — trust it heavily for category signals
- Hashtags like #bitcoin #eth → finance-crypto; #buildinpublic #saas → dev-tools/productivity

AVOID:
- Over-assigning "general" — it's a catch-all, not a default
- Conflating news about AI with AI resources (a news thread about OpenAI is "news", not "ai-resources")
- Assigning categories based only on passing mentions (a dev tweet that mentions a price = dev-tools, not finance)

Return ONLY valid JSON — no markdown, no explanation:
[{
  "tweetId": "123",
  "assignments": [
    {"category": "ai-resources", "confidence": 0.92},
    {"category": "dev-tools", "confidence": 0.71}
  ]
}]

BOOKMARKS:
${JSON.stringify(tweetData, null, 1)}`
}

function parseCategorizationResponse(text: string, validSlugs: Set<string>): CategorizationResult[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('No JSON array found in AI response')

  const parsed: unknown = JSON.parse(jsonMatch[0])
  if (!Array.isArray(parsed)) throw new Error('Claude response is not an array')

  return (parsed as Record<string, unknown>[]).map((item): CategorizationResult => {
    const tweetId = String(item.tweetId ?? '')
    const rawAssignments = Array.isArray(item.assignments) ? item.assignments : []

    const assignments: CategoryAssignment[] = (rawAssignments as Record<string, unknown>[])
      .map((a) => ({
        category: String(a.category ?? ''),
        confidence: typeof a.confidence === 'number' ? Math.min(1, Math.max(0.5, a.confidence)) : 0.8,
      }))
      .filter((a) => validSlugs.has(a.category))

    return { tweetId, assignments }
  })
}

export async function categorizeBatch(
  bookmarks: BookmarkForCategorization[],
  client: AIClient | null,
  categoryDescriptions: Record<string, string> = {},
  allSlugs: string[] = DEFAULT_SLUGS,
): Promise<CategorizationResult[]> {
  if (bookmarks.length === 0) return []

  const prompt = buildCategorizationPrompt(bookmarks, categoryDescriptions, allSlugs)
  const provider = await getProvider()

  // Prefer CLI over SDK (avoids OAuth token extraction, uses CLI directly)
  if (provider === 'openai') {
    if (await getCodexCliAvailability()) {
      const result = await codexPrompt(prompt, { timeoutMs: 60_000 })
      if (result.success && result.data) {
        try {
          return parseCategorizationResponse(result.data, new Set(allSlugs))
        } catch (parseErr) {
          console.warn('[categorize] Codex CLI response parse failed, falling back to SDK:', parseErr)
        }
      } else {
        console.warn('[categorize] Codex CLI failed, falling back to SDK:', result.error)
      }
    }
  } else {
    if (await getCliAvailability()) {
      const model = await getActiveModel()
      const cliModel = modelNameToCliAlias(model)

      const result = await claudePrompt(prompt, { model: cliModel, timeoutMs: 60_000 })
      if (result.success && result.data) {
        try {
          return parseCategorizationResponse(result.data, new Set(allSlugs))
        } catch (parseErr) {
          console.warn('[categorize] CLI response parse failed, falling back to SDK:', parseErr)
        }
      } else {
        console.warn('[categorize] CLI failed, falling back to SDK:', result.error)
      }
    }
  }

  // Fallback to SDK (requires API key)
  if (!client) {
    throw new Error('No CLI available and no API key configured.')
  }

  const model = await getActiveModel()
  const response = await client.createMessage({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })

  if (!response.text) throw new Error('No text content in AI response')

  return parseCategorizationResponse(response.text, new Set(allSlugs))
}

export async function writeCategoryResults(results: CategorizationResult[]): Promise<void> {
  if (results.length === 0) return

  const tweetIds = results.map((r) => r.tweetId).filter(Boolean)
  if (tweetIds.length === 0) return

  // Batch-fetch all categories and bookmarks at once (eliminates N+1 queries)
  const [categories, bookmarks] = await Promise.all([
    prisma.category.findMany({ select: { id: true, slug: true } }),
    prisma.bookmark.findMany({
      where: { tweetId: { in: tweetIds } },
      select: { id: true, tweetId: true },
    }),
  ])

  const categoryBySlug = new Map(categories.map((c) => [c.slug, c.id]))
  const bookmarkByTweetId = new Map(bookmarks.map((b) => [b.tweetId, b.id]))
  const now = new Date()

  // Collect all operations then execute in a single transaction (eliminates sequential await overhead)
  const upsertOps: ReturnType<typeof prisma.bookmarkCategory.upsert>[] = []
  const bookmarkIdsToUpdate: string[] = []

  for (const result of results) {
    if (!result.tweetId || result.assignments.length === 0) continue
    const bookmarkId = bookmarkByTweetId.get(result.tweetId)
    if (!bookmarkId) continue

    for (const { category: slug, confidence } of result.assignments) {
      const categoryId = categoryBySlug.get(slug)
      if (!categoryId) continue
      upsertOps.push(
        prisma.bookmarkCategory.upsert({
          where: { bookmarkId_categoryId: { bookmarkId, categoryId } },
          update: { confidence },
          create: { bookmarkId, categoryId, confidence },
        }),
      )
    }
    bookmarkIdsToUpdate.push(bookmarkId)
  }

  if (upsertOps.length === 0) return

  await prisma.$transaction([
    ...upsertOps,
    prisma.bookmark.updateMany({
      where: { id: { in: bookmarkIdsToUpdate } },
      data: { enrichedAt: now },
    }),
  ])
}

export function mapBookmarkForCategorization(b: {
  tweetId: string
  text: string
  semanticTags: string | null
  entities: string | null
  mediaItems: { imageTags: string | null }[]
}): BookmarkForCategorization {
  const allImageTags = b.mediaItems
    .map((m) => m.imageTags)
    .filter((t): t is string => t !== null && t !== '')
    .join(' | ')

  let semanticTags: string[] | undefined
  if (b.semanticTags) {
    try { semanticTags = JSON.parse(b.semanticTags) as string[] } catch { /* ignore */ }
  }

  let hashtags: string[] | undefined
  let tools: string[] | undefined
  if (b.entities) {
    try {
      const ent = JSON.parse(b.entities) as { hashtags?: string[]; tools?: string[] }
      hashtags = ent.hashtags
      tools = ent.tools
    } catch { /* ignore */ }
  }

  return {
    tweetId: b.tweetId,
    text: b.text,
    imageTags: allImageTags || undefined,
    semanticTags,
    hashtags,
    tools,
  }
}

export const BOOKMARK_SELECT = {
  id: true,
  tweetId: true,
  text: true,
  semanticTags: true,
  entities: true,
  mediaItems: { select: { imageTags: true } },
} as const

export async function categorizeAll(
  bookmarkIds: string[],
  onProgress?: (done: number, total: number) => void,
  force = false,
  shouldAbort?: () => boolean,
): Promise<void> {
  await seedDefaultCategories()

  // Resolve auth once — avoids re-resolving inside every batch call
  const provider = await getProvider()
  const keyName = provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
  const apiKeySetting = await prisma.setting.findUnique({ where: { key: keyName } })
  let client: AIClient | null = null
  try {
    client = await resolveAIClient({ dbKey: apiKeySetting?.value })
  } catch {
    // CLI might still work — client stays null
  }

  // Load ALL categories (default + custom) for the prompt
  const dbCategories = await prisma.category.findMany({ select: { slug: true, name: true, description: true } })
  const allSlugs = dbCategories.map((c) => c.slug)
  const categoryDescriptions = Object.fromEntries(
    dbCategories.map((c) => [c.slug, c.description?.trim() || c.name]),
  )

  // Get total count for progress reporting (without loading all rows)
  let total = 0
  if (bookmarkIds.length > 0) {
    total = bookmarkIds.length
  } else if (force) {
    total = await prisma.bookmark.count()
  } else {
    total = await prisma.bookmark.count({ where: { enrichedAt: null } })
  }

  let done = 0

  if (bookmarkIds.length > 0) {
    // Specific bookmark IDs — fetch in BATCH_SIZE chunks
    for (let i = 0; i < bookmarkIds.length; i += BATCH_SIZE) {
      if (shouldAbort?.()) break
      const batchIds = bookmarkIds.slice(i, i + BATCH_SIZE)
      const rows = await prisma.bookmark.findMany({
        where: { id: { in: batchIds } },
        select: BOOKMARK_SELECT,
      })
      const batch = rows.map(mapBookmarkForCategorization)
      try {
        const results = await categorizeBatch(batch, client, categoryDescriptions, allSlugs)
        await writeCategoryResults(results)
      } catch (err) {
        console.error(`Error categorizing batch at index ${i}:`, err)
      }
      done = Math.min(i + BATCH_SIZE, total)
      onProgress?.(done, total)
    }
  } else {
    // Cursor-based pagination — never loads all bookmarks into memory
    let cursor: string | undefined
    const where = force ? {} : { enrichedAt: null }

    while (true) {
      if (shouldAbort?.()) break

      const rows = await prisma.bookmark.findMany({
        where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        select: BOOKMARK_SELECT,
      })

      if (rows.length === 0) break
      cursor = rows[rows.length - 1].id

      const batch = rows.map(mapBookmarkForCategorization)
      try {
        const results = await categorizeBatch(batch, client, categoryDescriptions, allSlugs)
        await writeCategoryResults(results)
      } catch (err) {
        console.error('Error categorizing batch:', err)
      }

      done += rows.length
      onProgress?.(Math.min(done, total), total)

      if (rows.length < BATCH_SIZE) break
    }
  }
}
