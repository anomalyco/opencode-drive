import { createRng, type Rng } from "./random.js"
import type { ConfigJson } from "./config.js"

/**
 * Virtual filesystem generation.
 *
 * Configs reference files (skills, instructions, references); a coherent
 * initial state must actually contain those files, otherwise the derived
 * model and the real OpenCode behavior diverge for boring reasons.
 */
export interface VirtualFile {
  readonly path: string
  readonly content: string
}

export interface VirtualFileTree {
  readonly files: ReadonlyArray<VirtualFile>
}

const skillPool: Record<string, string> = {
  "code-review": "Review changes for bugs, regressions, and risky patterns.",
  "diagnosing-bugs": "Build a tight pass/fail signal before guessing at causes.",
  "release-notes": "Summarize shipped changes for users.",
  "ast-grep": "Search code structurally with ast-grep patterns.",
}

const instructionPool = [
  "Answer concisely. Lead with the conclusion.",
  "Prefer small verifiable steps. Run the tests you touch.",
  "Never commit secrets. Ask before external side effects.",
]

const title = (name: string): string =>
  name
    .split("-")
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(" ")

export const normalizePath = (value: string): string => value.replace(/^\.\//, "").replace(/\/+$/, "")

const isLocalPath = (value: string): boolean => !value.includes("://")

const skillFile = (root: string, name: string, description: string): VirtualFile => ({
  path: `${root}/${name}/SKILL.md`,
  content: ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${title(name)}`, "", description, ""].join(
    "\n",
  ),
})

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const referencePath = (entry: unknown): string | undefined => {
  if (typeof entry === "string") return entry
  if (typeof entry === "object" && entry !== null && "path" in entry) {
    const path = (entry as { readonly path: unknown }).path
    if (typeof path === "string") return path
  }
  return undefined
}

const referenceFiles = (config: ConfigJson, rng: Rng): VirtualFile[] => {
  const references = config.references
  if (typeof references !== "object" || references === null || Array.isArray(references)) return []
  return Object.entries(references).flatMap(([name, entry]) => {
    const path = referencePath(entry)
    if (path === undefined || !isLocalPath(path)) return []
    return [
      {
        path: `${normalizePath(path)}/README.md`,
        content: `# ${title(name)}\n\n${rng.pick(instructionPool)}\n`,
      },
    ]
  })
}

export const generateFilesForConfig = (config: ConfigJson, seed: number): VirtualFileTree => {
  const rng = createRng(seed)
  const files: VirtualFile[] = []

  for (const source of stringArray(config.skills).filter(isLocalPath)) {
    const root = normalizePath(source)
    for (const name of rng.sample(Object.keys(skillPool), rng.int(1, 3))) {
      files.push(skillFile(root, name, skillPool[name]!))
    }
  }

  for (const path of stringArray(config.instructions).filter(isLocalPath)) {
    files.push({ path: normalizePath(path), content: `${rng.pick(instructionPool)}\n` })
  }

  files.push(...referenceFiles(config, rng))

  return { files }
}
