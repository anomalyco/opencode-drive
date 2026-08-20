import { isAbsolute, relative, resolve, sep } from "node:path"

export function publicFilePath(root: string, pathname: string) {
  const decoded = fullyDecode(pathname)
  if (decoded === undefined || decoded.includes("\\")) return undefined

  const path = resolve(root, decoded.replace(/^\/+/, ""))
  const fromRoot = relative(root, path)
  if (fromRoot === "" || isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`))
    return undefined
  return path
}

function fullyDecode(value: string) {
  try {
    for (let index = 0; index < 8; index++) {
      const decoded = decodeURIComponent(value)
      if (decoded === value) return decoded
      value = decoded
    }
  } catch {
    return undefined
  }
  return undefined
}
