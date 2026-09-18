import { findBestV4Pool, findBestPool } from "../dip-swap.mjs";

const IMD = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";

const v4 = await findBestV4Pool(IMD).catch((e) => ({ error: e.message }));
console.log("findBestV4Pool:", JSON.stringify(v4, null, 2)?.slice(0, 400));

const v3 = await findBestPool(IMD).catch((e) => ({ error: e.message }));
console.log("findBestPool:", JSON.stringify(v3, (k, v) => typeof v === "bigint" ? String(v) : v)?.slice(0, 300));
