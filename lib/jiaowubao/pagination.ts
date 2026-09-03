/**
 * Collect an offset-paginated upstream response without relying on a vendor's
 * undocumented `total` or page-size behaviour. It is intentionally framework
 * free so the safety rule can be exercised with a mocked server response.
 */
export async function collectPagesUntilEmpty<T>(input: {
  maxPages: number;
  requestPage: (page: number) => Promise<T[]>;
  recordKey: (record: T) => string;
  protocolError: (message: string) => Error;
}): Promise<{ rows: T[]; pages: number }> {
  const seenRows = new Map<string, string>();
  const seenPageFingerprints = new Set<string>();
  let pagesWithRows = 0;

  // maxPages is the maximum number of non-empty data pages. One additional
  // request proves the final data page is truly followed by an empty page;
  // otherwise a month at the configured page count would be rejected.
  for (let page = 1; page <= input.maxPages + 1; page += 1) {
    const rows = await input.requestPage(page);
    if (!rows.length) {
      return { rows: [...seenRows.values()].map((value) => JSON.parse(value) as T), pages: pagesWithRows };
    }
    if (pagesWithRows >= input.maxPages) {
      throw input.protocolError("教务宝分页超过安全上限，未生成课时表。");
    }

    const fingerprint = rows.map(input.recordKey).join("|");
    if (seenPageFingerprints.has(fingerprint)) {
      throw input.protocolError("教务宝分页重复返回同一页，已停止避免重复计算。");
    }
    seenPageFingerprints.add(fingerprint);
    pagesWithRows += 1;

    for (const row of rows) {
      const key = input.recordKey(row);
      const signature = JSON.stringify(row);
      const previous = seenRows.get(key);
      if (previous && previous !== signature) {
        throw input.protocolError(`课节 ${key} 在不同页出现冲突数据。`);
      }
      seenRows.set(key, signature);
    }
  }

  throw input.protocolError("教务宝分页超过安全上限，未生成课时表。");
}
