/** Move a vault path, including descendants and page-range keys for split PDFs. */
export function remapPath(path: string, oldPath: string, newPath: string): string {
  return path === oldPath || path.startsWith(`${oldPath}/`) || path.startsWith(`${oldPath}#p`)
    ? newPath + path.slice(oldPath.length)
    : path;
}
