import { sha256Hex } from "@zevium/shared";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  harness,
  seed,
  identity,
  draftProject,
  pass,
  spec,
  webhook,
  webhookSecret,
} from "./helpers";
import type { Id } from "../convex/_generated/dataModel";
import { api, internal } from "../convex/_generated/api";
import {
  credentialBinding,
  encryptSecret,
  decryptSecret,
} from "../convex/lib/credentialCrypto";
import { MIN_DEPRECATION_NOTICE_MS } from "../convex/projects";
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv(
    "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS",
    JSON.stringify({ current: "v1", keys: { v1: btoa("k".repeat(32)) } }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("immutable publishing and bounded readiness", () => {
  it("requires admin and current proof, reserves routes transactionally and freezes published specs", async () => {
    const t = harness();
    await seed(t);
    const p = await draftProject(t);
    const admin = t.withIdentity(identity());
    expect(
      (
        await admin.mutation(api.specs.publish, {
          draftHash: await sha256Hex(spec),
          projectId: p._id,
          version: "1.0.0",
        })
      ).ok,
    ).toBe(false);
    await pass(t, p._id);
    await expect(
      t
        .withIdentity(identity("one", "member", "org:member"))
        .mutation(api.specs.publish, {
          draftHash: await sha256Hex(spec),
          projectId: p._id,
          version: "1.0.0",
        }),
    ).rejects.toThrow("admin");
    const result = await admin.mutation(api.specs.publish, {
      draftHash: await sha256Hex(spec),
      projectId: p._id,
      version: "1.0.0",
    });
    expect(result.ok).toBe(true);
    expect(
      await t.run((ctx) => ctx.db.query("routeTombstones").collect()),
    ).toHaveLength(1);
    expect(
      (
        await admin.mutation(api.specs.publish, {
          draftHash: await sha256Hex(spec),
          projectId: p._id,
          version: "1.0.0",
        })
      ).ok,
    ).toBe(false);
    const draft = (await admin.query(api.specs.getDraft, {
      projectId: p._id,
    }))!;
    const changed = spec.replace('"title":"Echo"', '"title":"Next"');
    await admin.mutation(api.specs.saveDraft, {
      projectId: p._id,
      spec: changed,
      baseHash: draft.draftHash,
    });
    const stored = await t.run((ctx) => ctx.db.query("specVersions").first());
    expect(stored?.spec).toBe(spec);
    expect(
      (await admin.query(api.publishReadiness.getCurrent, { projectId: p._id }))
        .current,
    ).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(p._id)))?.endpointCount).toBe(2); // Unpriced operation excluded; explicit zero retained.
    await expect(
      admin.mutation(api.organizations.setPublicHandle, {
        handle: "different",
      }),
    ).rejects.toThrow("permanent");
  });
  it("preserves concurrent draft conflict state and readiness on identical retry", async () => {
    const t = harness();
    await seed(t);
    const p = await draftProject(t),
      admin = t.withIdentity(identity());
    await pass(t, p._id);
    const before = (await admin.query(api.specs.getDraft, {
      projectId: p._id,
    }))!;
    await admin.mutation(api.specs.saveDraft, {
      projectId: p._id,
      spec,
      baseHash: "stale",
    });
    expect(
      (await admin.query(api.publishReadiness.getCurrent, { projectId: p._id }))
        .current,
    ).toBe(true);
    const conflict = await admin.mutation(api.specs.saveDraft, {
      projectId: p._id,
      spec: spec.replace("Echo", "Changed"),
      baseHash: "stale",
    });
    expect(conflict).toMatchObject({
      conflict: true,
      draft: before.draft,
      draftHash: before.draftHash,
    });
    expect(
      (await admin.query(api.publishReadiness.getCurrent, { projectId: p._id }))
        .current,
    ).toBe(true);
  });
  it("invalidates readiness on secret changes, expired tests and stale target proof", async () => {
    const t = harness();
    await seed(t);
    const p = await draftProject(t),
      admin = t.withIdentity(identity());
    const target = await t.query(internal.publishReadiness.getTarget, {
      projectId: p._id,
      clerkOrgId: "org_one",
    });
    await pass(t, p._id);
    const credential = await admin.mutation(api.upstreamCredentials.upsert, {
      projectId: p._id,
      name: "Authorization",
      secret: "Bearer private-token",
    });
    expect(
      (await admin.query(api.publishReadiness.getCurrent, { projectId: p._id }))
        .current,
    ).toBe(false);
    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId: p._id,
        draftHash: target.draftHash!,
        credentialFingerprint: target.credentialFingerprint,
        healthCheckUrl: target.url!,
        healthCheckMethod: target.method!,
      }),
    ).toBe(false);
    await pass(t, p._id);
    expect(
      (
        await admin.mutation(api.specs.publish, {
          draftHash: await sha256Hex(spec),
          projectId: p._id,
          version: "1.0.0",
        })
      ).ok,
    ).toBe(true);
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
    expect(
      (
        await admin.mutation(api.specs.publish, {
          draftHash: await sha256Hex(spec),
          projectId: p._id,
          version: "1.0.1",
        })
      ).ok,
    ).toBe(false);
    await admin.mutation(api.upstreamCredentials.remove, {
      credentialId: credential.id,
    });
    await expect(
      t.withIdentity(identity("two")).mutation(api.upstreamCredentials.remove, {
        credentialId: credential.id,
      }),
    ).rejects.toThrow(/unavailable|already exists/);
  });
  it("keeps suspension and publication generation during metadata/retirement edits", async () => {
    const t = harness();
    await seed(t);
    const p = await draftProject(t),
      admin = t.withIdentity(identity());
    await pass(t, p._id);
    await admin.mutation(api.specs.publish, {
      draftHash: await sha256Hex(spec),
      projectId: p._id,
      version: "1.0.0",
    });
    await admin.mutation(api.projects.scheduleRetirement, {
      projectId: p._id,
      sunsetAt: Date.now() + MIN_DEPRECATION_NOTICE_MS,
      message: "Retiring",
    });
    await t.run((ctx) =>
      ctx.db.patch(p._id, {
        qualityStatus: "suspended",
        visibility: "private",
        description: "Clear me",
      }),
    );
    await admin.mutation(api.projects.update, {
      projectId: p._id,
      patch: { description: null, visibility: "public" },
    });
    await admin.mutation(api.projects.cancelRetirement, { projectId: p._id });
    const row = await t.run((ctx) => ctx.db.get(p._id));
    expect(row).toMatchObject({
      qualityStatus: "suspended",
      visibility: "private",
      desiredVisibility: "public",
      publicationGeneration: 1,
      discoverable: false,
    });
    expect(row?.description).toBeUndefined();
    expect(row?.retirement).toBeUndefined();
    await expect(
      t
        .withIdentity(identity("one", "member", "org:member"))
        .mutation(api.projects.update, {
          projectId: p._id,
          patch: { name: "Live edit" },
        }),
    ).rejects.toThrow("admin");
  });
  it("fences old retirement jobs after cancel/reschedule and preserves permanent routes", async () => {
    const t = harness();
    await seed(t);
    const p = await draftProject(t),
      admin = t.withIdentity(identity());
    await pass(t, p._id);
    await admin.mutation(api.specs.publish, {
      draftHash: await sha256Hex(spec),
      projectId: p._id,
      version: "1.0.0",
    });
    const sunset = Date.now() + MIN_DEPRECATION_NOTICE_MS;
    await expect(
      admin.mutation(api.projects.scheduleRetirement, {
        projectId: p._id,
        sunsetAt: sunset - 1,
        message: "Soon",
      }),
    ).rejects.toThrow("seven days");
    const first = await admin.mutation(api.projects.scheduleRetirement, {
      projectId: p._id,
      sunsetAt: sunset,
      message: "Retire",
    });
    await admin.mutation(api.projects.cancelRetirement, { projectId: p._id });
    await admin.mutation(api.projects.scheduleRetirement, {
      projectId: p._id,
      sunsetAt: sunset + 1000,
      message: "New notice",
    });
    vi.setSystemTime(sunset);
    await t.mutation(internal.projects.retireScheduled, {
      projectId: p._id,
      revision: first.retirementRevision!,
    });
    expect((await t.run((ctx) => ctx.db.get(p._id)))?.retirement?.state).toBe(
      "scheduled",
    );
    vi.setSystemTime(sunset + 1000);
    expect(
      await t.query(api.specs.getPublishedForGateway, {
        publisherHandle: "one",
        projectSlug: "echo",
      }),
    ).toBeNull();
    await t.mutation(internal.projects.retireSunsetProjects, {});
    expect(
      (await t.run((ctx) => ctx.db.query("routeTombstones").first()))
        ?.retiredAt,
    ).toBeDefined();
    expect(
      await t.run((ctx) => ctx.db.query("specVersions").collect()),
    ).toHaveLength(1);
    await expect(
      admin.mutation(api.projects.create, {
        orgSlug: "one",
        slug: "echo",
        name: "Reuse",
      }),
    ).rejects.toThrow(/unavailable|already exists/);
  });
  it("denies private/cross-tenant routes and excludes embedded secrets from every implemented DTO", async () => {
    const t = harness();
    await seed(t);
    const p = await draftProject(t),
      admin = t.withIdentity(identity());
    const secret = "publisher-private-value";
    const credential = await admin.mutation(api.upstreamCredentials.upsert, {
      projectId: p._id,
      name: "Authorization",
      secret,
    });
    const envelope = await encryptSecret(secret, {
      purpose: "webhook-signing-secret",
      resource: p._id,
      generation: 1,
    });
    await t.run((ctx) =>
      ctx.db.patch(p._id, {
        webhook: {
          url: "https://private.example.com",
          active: true,
          current: envelope,
          secretVersion: 1,
          createdAt: Date.now(),
        },
      }),
    );
    await pass(t, p._id);
    const publication = await admin.mutation(api.specs.publish, {
      draftHash: await sha256Hex(spec),
      projectId: p._id,
      version: "1.0.0",
    });
    for (const value of [
      publication,
      await admin.query(api.projects.list, {
        orgSlug: "one",
        paginationOpts: { cursor: null, numItems: 50 },
      }),
      await admin.query(api.projects.get, {
        orgSlug: "one",
        projectSlug: "echo",
      }),
      await admin.query(api.upstreamCredentials.listForProject, {
        projectId: p._id,
      }),
      await t.query(api.specs.getPublishedForGateway, {
        publisherHandle: "one",
        projectSlug: "echo",
      }),
    ]) {
      expect(JSON.stringify(value)).not.toContain(secret);
      expect(JSON.stringify(value)).not.toMatch(
        /ciphertext|private\.example\.com|credentialFingerprint/,
      );
    }
    await expect(
      t
        .withIdentity(identity("two"))
        .query(api.specs.getDraft, { projectId: p._id }),
    ).rejects.toThrow("Project not found");
    await expect(
      t.withIdentity(identity("two")).mutation(api.upstreamCredentials.remove, {
        credentialId: credential.id,
      }),
    ).rejects.toThrow("Upstream credential unavailable");
    await t.run((ctx) => ctx.db.patch(p._id, { visibility: "private" }));
    expect(
      await t.query(api.specs.getPublishedForGateway, {
        publisherHandle: "one",
        projectSlug: "echo",
      }),
    ).toBeNull();
  });
  it("rejects token pricing and multiple upstreams without modifying saved draft", async () => {
    const t = harness();
    await seed(t);
    const p = await draftProject(t),
      admin = t.withIdentity(identity());
    const before = (await admin.query(api.specs.getDraft, {
      projectId: p._id,
    }))!;
    for (const text of [
      spec.replace(
        '"x-zevium-cost":5',
        '"x-zevium-cost":{"type":"tokens","input":1,"output":2,"maxPerCall":100}',
      ),
      spec.replace(
        '"servers":[{"url":"https://api.example.com"}]',
        '"servers":[{"url":"https://api.example.com"},{"url":"https://other.example.com"}]',
      ),
    ]) {
      expect(
        (
          await admin.mutation(api.specs.saveDraft, {
            projectId: p._id,
            spec: text,
            baseHash: before.draftHash,
          })
        ).ok,
      ).toBe(false);
      expect(
        await admin.query(api.specs.getDraft, { projectId: p._id }),
      ).toEqual(before);
    }
  });
  it("deprecates metadata without replacing immutable spec/hash, and respects cutoff", async () => {
    const t = harness();
    await seed(t);
    const p = await draftProject(t),
      admin = t.withIdentity(identity());
    await pass(t, p._id);
    await admin.mutation(api.specs.publish, {
      draftHash: await sha256Hex(spec),
      projectId: p._id,
      version: "1.0.0",
    });
    const version = (await t.run((ctx) =>
      ctx.db.query("specVersions").first(),
    ))!;
    await admin.mutation(api.specs.deprecateVersion, {
      versionId: version._id,
      sunsetAt: Date.now() + MIN_DEPRECATION_NOTICE_MS,
      message: "Use next",
    });
    await admin.mutation(api.specs.undeprecateVersion, {
      versionId: version._id,
    });
    expect(await t.run((ctx) => ctx.db.get(version._id))).toEqual(version);
    await admin.mutation(api.specs.deprecateVersion, {
      versionId: version._id,
      sunsetAt: Date.now() + MIN_DEPRECATION_NOTICE_MS,
    });
    vi.setSystemTime(Date.now() + MIN_DEPRECATION_NOTICE_MS);
    await expect(
      admin.mutation(api.specs.undeprecateVersion, { versionId: version._id }),
    ).rejects.toThrow("sunset");
  });
});
describe("single AAD-bound secret envelope", () => {
  it("rejects row, purpose, generation, version and ciphertext transplants", async () => {
    const binding = credentialBinding("project", "authorization", 1),
      envelope = await encryptSecret("private-value", binding);
    expect(await decryptSecret(envelope, binding)).toBe("private-value");
    for (const other of [
      credentialBinding("other", "authorization", 1),
      credentialBinding("project", "x-api-key", 1),
      credentialBinding("project", "authorization", 2),
      { ...binding, purpose: "webhook-signing-secret" as const },
    ])
      await expect(decryptSecret(envelope, other)).rejects.toThrow(
        "unavailable",
      );
    await expect(
      decryptSecret({ ...envelope, keyVersion: "toString" }, binding),
    ).rejects.toThrow("unavailable");
    await expect(
      decryptSecret({ ...envelope, ciphertext: btoa("tampered") }, binding),
    ).rejects.toThrow("unavailable");
    expect(Object.keys(envelope).sort()).toEqual([
      "ciphertext",
      "format",
      "iv",
      "keyVersion",
    ]);
  });
  it("retains configured old versions and rejects legacy/noncanonical key material", async () => {
    const binding = credentialBinding("project", "authorization", 1),
      envelope = await encryptSecret("private", binding);
    vi.stubEnv(
      "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS",
      JSON.stringify({
        current: "v2",
        keys: { v1: btoa("k".repeat(32)), v2: btoa("n".repeat(32)) },
      }),
    );
    expect(await decryptSecret(envelope, binding)).toBe("private");
    vi.stubEnv(
      "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS",
      JSON.stringify({ current: "v1", keys: { v1: "legacy-plaintext-key" } }),
    );
    await expect(encryptSecret("private", binding)).rejects.toThrow(
      "not configured",
    );
  });
});

it("rejects stale publish hashes even when a collaborator has refreshed readiness", async () => {
  const t = harness();
  await seed(t);
  const project = await draftProject(t);
  const admin = t.withIdentity(identity());
  const before = (await admin.query(api.specs.getDraft, {
    projectId: project._id,
  }))!;
  const changed = spec.replace("Echo", "Collaborator edit");
  const saved = await admin.mutation(api.specs.saveDraft, {
    projectId: project._id,
    spec: changed,
    baseHash: before.draftHash,
  });
  await pass(t, project._id);
  const conflict = await admin.mutation(api.specs.publish, {
    projectId: project._id,
    version: "1.0.0",
    draftHash: before.draftHash,
  });
  expect(conflict).toEqual(
    await admin.mutation(api.specs.saveDraft, {
      projectId: project._id,
      spec,
      baseHash: before.draftHash,
    }),
  );
  expect(conflict).toMatchObject({
    ok: false,
    conflict: true,
    draft: changed,
    draftHash: saved.draftHash,
  });
  expect(await t.run((ctx) => ctx.db.query("specVersions").collect())).toEqual(
    [],
  );
  expect(
    await t.run((ctx) => ctx.db.query("routeTombstones").collect()),
  ).toEqual([]);
  expect(
    await admin.mutation(api.specs.publish, {
      projectId: project._id,
      version: "1.0.0",
      draftHash: saved.draftHash!,
    }),
  ).toMatchObject({ ok: true });
});

it.each(["archive", "sunset"])(
  "keeps large drafts out of paginated projects and %s cleanup",
  async (cleanup) => {
    vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", webhookSecret);
    const t = harness();
    await seed(t);
    const admin = t.withIdentity(identity());
    const large = spec.replace(
      '"title":"Echo"',
      '"title":"Echo","description":"' + "x".repeat(390_000) + '"',
    );
    const ids: Id<"projects">[] = [];
    for (let i = 0; i < 55; i++) {
      const project = await admin.mutation(api.projects.create, {
        orgSlug: "one",
        name: `Project ${i}`,
        slug: `project-${String(i).padStart(2, "0")}`,
      });
      ids.push(project._id);
      expect(
        await admin.mutation(api.specs.saveDraft, {
          projectId: project._id,
          spec: large,
          baseHash: await sha256Hex(""),
        }),
      ).toMatchObject({ ok: true });
    }
    const rows = await t.run((ctx) => ctx.db.query("projects").collect());
    expect(
      new TextEncoder().encode(JSON.stringify(rows)).byteLength,
    ).toBeLessThan(100_000);
    for (const row of rows) {
      expect(row.draft).toMatchObject({
        revision: 2,
        hash: await sha256Hex(large),
      });
      expect(row.draft).not.toHaveProperty("text");
    }
    const first = await admin.query(api.projects.list, {
      orgSlug: "forged-other-org",
      paginationOpts: { cursor: null, numItems: 1000 },
    });
    expect(first.page).toHaveLength(50);
    expect(first.isDone).toBe(false);
    const second = await admin.query(api.projects.list, {
      orgSlug: "one",
      paginationOpts: { cursor: first.continueCursor, numItems: 50 },
    });
    expect(second.page).toHaveLength(5);
    expect(second.isDone).toBe(true);
    expect(
      new Set([...first.page, ...second.page].map((row) => row._id)).size,
    ).toBe(55);
    const draft = (await admin.query(api.specs.getDraft, {
      projectId: ids[0]!,
    }))!;
    expect(draft.draft).toBe(large);
    await admin.mutation(api.specs.saveDraft, {
      projectId: ids[0]!,
      spec: large,
      baseHash: "stale",
    });
    expect(await t.run((ctx) => ctx.db.get(ids[0]!))).toEqual(rows[0]);
    if (cleanup === "archive") {
      expect(
        (
          await webhook(t, "archive-large", "organization.deleted", {
            id: "org_one",
          })
        ).status,
      ).toBe(200);
    } else {
      await t.run(async (ctx) => {
        for (const id of ids)
          await ctx.db.patch(id, {
            retirement: {
              state: "scheduled",
              revision: 1,
              message: "Retiring",
              startedAt: Date.now() - MIN_DEPRECATION_NOTICE_MS,
              sunsetAt: Date.now(),
              cleanupPhase: "pending",
            },
          });
      });
      await t.mutation(internal.projects.retireSunsetProjects, {});
    }
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const retired = await t.run((ctx) => ctx.db.query("projects").collect());
    expect(retired).toHaveLength(55);
    for (const row of retired) expect(row.retirement?.state).toBe("retired");
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("projectDrafts")
          .withIndex("by_project", (q) => q.eq("projectId", ids[0]!))
          .unique(),
      ),
    ).toMatchObject({ text: large, revision: 2 });
  },
);
