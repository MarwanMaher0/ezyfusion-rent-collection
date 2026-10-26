import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userClient } from "../helpers/clients";
import { closePool } from "../helpers/db";
import { createFixtureOrg, insertLease, type FixtureOrg } from "../helpers/fixtures";
import { api } from "../helpers/http";

// D73: payments is in the supabase_realtime publication; postgres_changes are filtered by RLS with
// the subscriber's JWT. Tenant A (on the lease) must get the INSERT; tenant B (same org, own lease on
// another unit) and another org's manager must get nothing. The payment is recorded through the real
// route as the fixture manager, so the event is the one the tenant portal would react to.

const LEASE = { startDate: "2026-01-01", endDate: "2026-12-31", monthlyRentSen: 100000, depositSen: 0 };
const SUBSCRIBE_TIMEOUT_MS = 20_000;
const WINDOW_MS = 15_000;

interface Sub {
  client: SupabaseClient;
  channel: RealtimeChannel;
  ids: string[]; // payment ids of every INSERT event received
}

let F: FixtureOrg;
let G: FixtureOrg;
const subs: Sub[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function subscribe(token: string, label: string): Promise<Sub> {
  const client = userClient(token);
  // userClient only sets the REST Authorization header; realtime needs the JWT explicitly or it
  // joins as anon (which would make a "receives nothing" assertion meaningless).
  await client.realtime.setAuth(token);
  const ids: string[] = [];
  const channel = client.channel(`rt-payments-${label}-${Math.random().toString(36).slice(2)}`);
  channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "payments" }, (payload) => {
    const id = (payload.new as { id?: unknown }).id;
    if (typeof id === "string") ids.push(id);
  });
  const sub: Sub = { client, channel, ids };
  subs.push(sub);
  // SUBSCRIBED only means the channel joined; postgres_changes go live when the server sends the
  // system message "Subscribed to PostgreSQL" (seen ~1 s later locally). Waiting for both avoids
  // an INSERT that slips in before the CDC subscription exists (a false "tenant A got nothing").
  await new Promise<void>((resolve, reject) => {
    let joined = false;
    let cdcReady = false;
    const t = setTimeout(
      () => reject(new Error(`${label}: not SUBSCRIBED (joined=${joined}, cdc=${cdcReady}) within ${SUBSCRIBE_TIMEOUT_MS} ms`)),
      SUBSCRIBE_TIMEOUT_MS,
    );
    const done = () => {
      if (joined && cdcReady) {
        clearTimeout(t);
        resolve();
      }
    };
    channel.on("system", {}, (msg: { extension?: string; status?: string; message?: string }) => {
      if (msg.extension !== "postgres_changes") return;
      if (msg.status === "ok") {
        cdcReady = true;
        done();
      } else {
        clearTimeout(t);
        reject(new Error(`${label}: postgres_changes subscription failed: ${msg.message ?? msg.status}`));
      }
    });
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        joined = true;
        done();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(t);
        reject(new Error(`${label}: subscribe status ${status}${err ? `: ${err.message}` : ""}`));
      }
    });
  });
  return sub;
}

beforeAll(async () => {
  [F, G] = await Promise.all([createFixtureOrg({ units: 2, lease: LEASE }), createFixtureOrg({ units: 1 })]);
  // Tenant B is a legitimate payments reader (own lease), so a missing RLS filter would show up.
  await insertLease(F.orgId, F.unitIds[1], F.tenantBId, LEASE, F.users.manager.userId);
});

afterAll(async () => {
  for (const s of subs) await s.client.removeChannel(s.channel).catch(() => undefined);
  for (const s of subs) s.client.realtime.disconnect();
  await closePool();
});

describe("R42 R56 realtime respects RLS", () => {
  it(
    "tenant A receives the INSERT for their lease's payment; tenant B and another org's manager receive nothing",
    async () => {
      const [a, b, other] = await Promise.all([
        subscribe(F.tokens.tenantA, "tenantA"),
        subscribe(F.tokens.tenantB, "tenantB"),
        subscribe(G.tokens.manager, "otherOrgManager"),
      ]);

      const started = Date.now();
      const r = await api(F.tokens.manager).post(`/api/leases/${F.lease!.id}/payments`, {
        amountSen: 100,
        method: "cash",
        receivedAt: new Date().toISOString(),
      });
      expect(r.status).toBe(201);
      const paymentId = (r.body as { id: string }).id;
      expect(typeof paymentId).toBe("string");

      while (!a.ids.includes(paymentId) && Date.now() - started < WINDOW_MS) await sleep(200);
      expect(a.ids, "tenant A got no realtime INSERT for their own payment").toContain(paymentId);

      // Keep listening for the rest of the window before asserting silence for the others.
      const left = WINDOW_MS - (Date.now() - started);
      if (left > 0) await sleep(left);
      expect(b.ids, "tenant B received a payment event they cannot SELECT").toEqual([]);
      expect(other.ids, "another org's manager received a payment event").toEqual([]);
    },
    90_000,
  );
});
