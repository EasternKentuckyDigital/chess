export const DEVICE_LIBRARY_LIMIT = 100;
export const CLOUD_LIBRARY_LIMIT = 500;
export const CLOUD_LIBRARY_BYTE_BUDGET = 750_000;

export function retainedLibraryRecords(current, previous = [], { cloud = false, byteBudget = CLOUD_LIBRARY_BYTE_BUDGET } = {}) {
  const limit = cloud ? CLOUD_LIBRARY_LIMIT : DEVICE_LIBRARY_LIMIT;
  const unique = new Map();
  for (const record of [...(current || []), ...(previous || [])]) {
    if (record?.id && !unique.has(record.id)) unique.set(record.id, record);
  }
  const retained = [];
  let bytes = 2;
  for (const record of unique.values()) {
    const recordBytes = new TextEncoder().encode(JSON.stringify(record)).length + 1;
    if (retained.length >= limit || bytes + recordBytes > byteBudget) break;
    retained.push(record);
    bytes += recordBytes;
  }
  return retained;
}
