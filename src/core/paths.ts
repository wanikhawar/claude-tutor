/** Move a vault path, including descendants and page-range keys for split PDFs. */
export function remapPath(path: string, oldPath: string, newPath: string): string {
  return path === oldPath || path.startsWith(`${oldPath}/`) || path.startsWith(`${oldPath}#p`)
    ? newPath + path.slice(oldPath.length)
    : path;
}

/** The pages a PDF's key covers: `#p<first>-<last>`, or all of them for a PDF read as one part. */
export function pageRange(key: string): [number, number] {
  const m = /#p(\d+)-(\d+)$/.exec(key);
  return m ? [Number(m[1]), Number(m[2])] : [1, Infinity];
}

export function overlaps([a, b]: [number, number], [c, d]: [number, number]): boolean {
  return a <= d && c <= b;
}
