#!/usr/bin/env node
/**
 * Refreshes htm/assets/regio-catalog.json from HTM's live wipkip/getdata + region
 * prices endpoints. Run this when the "regio-advies: bundled region catalog
 * matches live data" test in htm.test.mjs fails, then review the diff and
 * commit it. Reads HTM_LOGIN/HTM_PASSWORD the same way htm.mjs does.
 *
 * Usage: node .ci/htm/refresh.mjs
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { login, apiGet, orderApiCall, buildRegioCatalog, REGIO_VRIJ_PRODUCT_ID } from '../../htm/scripts/htm.mjs';

const session = await login();
const [wipkip, regionPrices] = await Promise.all([
  apiGet(session, '/v1/wipkip/getdata'),
  orderApiCall(session, 'GET', `/v3/order/product/regions/${REGIO_VRIJ_PRODUCT_ID}`),
]);

const catalog = buildRegioCatalog(wipkip, regionPrices);
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'htm', 'assets', 'regio-catalog.json');
writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Wrote ${catalog.regions.length} regions to ${outPath}`);
