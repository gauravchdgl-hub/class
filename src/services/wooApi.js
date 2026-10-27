// Minimal WooCommerce REST API client — no new npm dependency, uses global
// fetch (Node 18+) when available, falling back to the built-in https module.
// Reads store URL + API keys from site_settings (see admin.js Settings ->
// "WooCommerce API Connection").
const https = require('https');
const { URL } = require('url');
const db = require('../db');

const MAX_PAGES = 10; // 10 pages * 50/page = 500 orders, matching the task's "cap at ~500 orders" guidance.
const PER_PAGE = 50;

function getWooCredentials() {
  const get = (key) => {
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
    return row && row.value ? row.value : '';
  };
  return {
    storeUrl: (get('woo_store_url') || '').trim().replace(/\/+$/, ''),
    consumerKey: (get('woo_consumer_key') || '').trim(),
    consumerSecret: (get('woo_consumer_secret') || '').trim(),
  };
}

function isConfigured() {
  const { storeUrl, consumerKey, consumerSecret } = getWooCredentials();
  return !!(storeUrl && consumerKey && consumerSecret);
}

// Fetch one page via native fetch if present, else via https module. Returns
// { status, headers, body } so the caller can read X-WP-TotalPages either way.
function fetchPage(url, auth) {
  if (typeof fetch === 'function') {
    return fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    }).then(async (resp) => {
      const text = await resp.text();
      const headersObj = {};
      resp.headers.forEach((v, k) => { headersObj[k.toLowerCase()] = v; });
      return { status: resp.status, headers: headersObj, body: text };
    });
  }
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const headersObj = {};
        Object.keys(res.headers).forEach((k) => { headersObj[k.toLowerCase()] = res.headers[k]; });
        resolve({ status: res.statusCode, headers: headersObj, body: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request to WooCommerce store timed out')); });
    req.end();
  });
}

/**
 * Pulls recent orders from GET {store_url}/wp-json/wc/v3/orders, following
 * X-WP-TotalPages up to MAX_PAGES (sane cap against a runaway sync).
 * Throws a plain Error with a clear message on any failure — never returns
 * a fake success.
 * @returns {Promise<Array>} raw WooCommerce order objects
 */
async function fetchRecentOrders() {
  const { storeUrl, consumerKey, consumerSecret } = getWooCredentials();
  if (!storeUrl || !consumerKey || !consumerSecret) {
    throw new Error('WooCommerce API not configured — add your store URL and API keys in Settings.');
  }

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const allOrders = [];
  let totalPages = 1;

  for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page += 1) {
    const url = `${storeUrl}/wp-json/wc/v3/orders?per_page=${PER_PAGE}&page=${page}&orderby=date&order=desc`;
    let resp;
    try {
      resp = await fetchPage(url, auth);
    } catch (err) {
      throw new Error(`Could not reach WooCommerce store at ${storeUrl}: ${err.message}`);
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new Error('WooCommerce API rejected the request — check your Consumer Key/Secret in Settings.');
    }
    if (resp.status >= 400) {
      let msg = `WooCommerce API returned HTTP ${resp.status}`;
      try {
        const parsed = JSON.parse(resp.body);
        if (parsed && parsed.message) msg += `: ${parsed.message}`;
      } catch (e) { /* keep generic message */ }
      throw new Error(msg);
    }

    let pageOrders;
    try {
      pageOrders = JSON.parse(resp.body);
    } catch (e) {
      throw new Error('WooCommerce store returned a non-JSON response — check the store URL is correct and WooCommerce REST API is enabled.');
    }
    if (!Array.isArray(pageOrders)) {
      throw new Error('Unexpected response shape from WooCommerce /orders endpoint.');
    }
    allOrders.push(...pageOrders);

    if (page === 1) {
      const headerTotalPages = parseInt(resp.headers['x-wp-totalpages'], 10);
      if (headerTotalPages && headerTotalPages > 0) totalPages = headerTotalPages;
    }
    if (pageOrders.length === 0) break; // no more data
  }

  return allOrders;
}

module.exports = { getWooCredentials, isConfigured, fetchRecentOrders, MAX_PAGES, PER_PAGE };
