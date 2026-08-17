/**
 * Amazon Product Advertising API v5 (GetItems), signed with SigV4 by hand so
 * there is no SDK dependency. This is the *official* way to read Amazon prices
 * and requires an approved Associates account.
 *
 * Env: PAAPI_ACCESS_KEY, PAAPI_SECRET_KEY, PAAPI_PARTNER_TAG
 * Optional: PAAPI_HOST, PAAPI_REGION, PAAPI_MARKETPLACE
 */
import crypto from 'node:crypto';
import { politeFetch } from '../lib/http.js';

const HOST = process.env.PAAPI_HOST || 'webservices.amazon.com';
const REGION = process.env.PAAPI_REGION || 'us-east-1';
const MARKETPLACE = process.env.PAAPI_MARKETPLACE || 'www.amazon.com';
const SERVICE = 'ProductAdvertisingAPI';
const PATH = '/paapi5/getitems';
const TARGET = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems';

const sha256Hex = (data) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

function signingKey(secret, dateStamp) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), REGION), SERVICE), 'aws4_request');
}

function signedHeaders(payload) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    'content-encoding': 'amz-1.0',
    'content-type': 'application/json; charset=utf-8',
    host: HOST,
    'x-amz-date': amzDate,
    'x-amz-target': TARGET,
  };

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('');
  const signedHeaderList = names.join(';');

  const canonicalRequest = [
    'POST',
    PATH,
    '',
    canonicalHeaders,
    signedHeaderList,
    sha256Hex(payload),
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(process.env.PAAPI_SECRET_KEY, dateStamp), stringToSign).toString('hex');

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${process.env.PAAPI_ACCESS_KEY}/${scope}, ` +
      `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
  };
}

function extractPrice(listing) {
  const price = listing?.Price;
  const amount = price?.Amount ?? price?.Money?.Amount;
  if (!Number.isFinite(Number(amount))) return null;
  return {
    cents: Math.round(Number(amount) * 100),
    currency: price?.Currency ?? price?.Money?.Currency ?? 'USD',
  };
}

export default {
  name: 'paapi',
  label: 'Amazon Product Advertising API v5',
  retailer: 'Amazon',
  requires: ['PAAPI_ACCESS_KEY', 'PAAPI_SECRET_KEY', 'PAAPI_PARTNER_TAG'],
  notes: 'Official Amazon API. Requires an approved Associates account.',

  isConfigured: () =>
    !!(process.env.PAAPI_ACCESS_KEY && process.env.PAAPI_SECRET_KEY && process.env.PAAPI_PARTNER_TAG),

  async fetch(parts) {
    const targets = [];
    for (const part of parts) {
      const listing = part.listings.find((l) => l.retailer === 'Amazon' && l.asin);
      if (listing) targets.push({ part, listing });
    }
    if (!targets.length) return [];

    const out = [];
    const errors = [];

    // GetItems accepts at most 10 ItemIds per request.
    for (let i = 0; i < targets.length; i += 10) {
      const batch = targets.slice(i, i + 10);
      const payload = JSON.stringify({
        ItemIds: batch.map((t) => t.listing.asin),
        ItemIdType: 'ASIN',
        PartnerTag: process.env.PAAPI_PARTNER_TAG,
        PartnerType: 'Associates',
        Marketplace: MARKETPLACE,
        Resources: [
          'ItemInfo.Title',
          'Offers.Listings.Price',
          'Offers.Listings.Availability.Message',
          'Offers.Summaries.LowestPrice',
        ],
      });

      let body;
      try {
        const res = await politeFetch(`https://${HOST}${PATH}`, {
          method: 'POST',
          headers: signedHeaders(payload),
          body: payload,
        });
        body = await res.json();
        if (!res.ok) {
          const detail = body?.Errors?.map((e) => e.Message).join('; ') || `HTTP ${res.status}`;
          throw new Error(detail);
        }
      } catch (err) {
        errors.push(`paapi: batch failed (${err.message})`);
        continue;
      }

      const items = new Map((body.ItemsResult?.Items || []).map((it) => [it.ASIN, it]));
      const observedAt = new Date().toISOString();

      for (const { part, listing } of batch) {
        const item = items.get(listing.asin);
        const offer = item?.Offers?.Listings?.[0];
        const price =
          extractPrice(offer) ??
          extractPrice({ Price: item?.Offers?.Summaries?.[0]?.LowestPrice });

        if (!price) {
          out.push({
            part_id: part.id,
            retailer: 'Amazon',
            source: 'paapi',
            price_cents: 0,
            currency: 'USD',
            in_stock: 0,
            url: item?.DetailPageURL ?? listing.url ?? null,
            observed_at: observedAt,
          });
          continue;
        }

        out.push({
          part_id: part.id,
          retailer: 'Amazon',
          source: 'paapi',
          price_cents: price.cents,
          currency: price.currency,
          in_stock: 1,
          url: item?.DetailPageURL ?? listing.url ?? null,
          observed_at: observedAt,
        });
      }
    }

    if (errors.length) {
      const err = new Error(errors.join('; '));
      err.partial = out;
      throw err;
    }
    return out;
  },
};
