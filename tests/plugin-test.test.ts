import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { admin, organization } from "better-auth/plugins";
import { createAuthClient } from "better-auth/client";
import { parseSetCookieHeader } from "better-auth/cookies";
import { surrealAdapter } from "../src";
import { getDatabase } from "../db/surreal";
import Surreal from "surrealdb";

// Test configuration
const TEST_CONFIG = {
  address: "http://127.0.0.1:8000",
  username: "root",
  password: "root",
  ns: "plugin_test",
  db: "plugin_test",
};

describe("e2e: better-auth plugins (admin, organization, teams)", async () => {
  let rawDb: Surreal;
  let auth: ReturnType<typeof betterAuth>;
  let client: ReturnType<typeof createAuthClient>;
  const timestamp = Date.now();
  const testUser = {
    email: `plugin-test-${timestamp}@example.com`,
    password: "password123",
    name: "Plugin Test User",
  };

  // Helper to extract session cookie
  function sessionSetter(headers: Headers) {
    return (context: { response: Response }) => {
      const header = context.response.headers.get("set-cookie");
      if (header) {
        const cookies = parseSetCookieHeader(header || "");
        const signedCookie = cookies.get("better-auth.session_token")?.value;
        headers.set("cookie", `better-auth.session_token=${signedCookie}`);
      }
    };
  }

  beforeAll(async () => {
    rawDb = await getDatabase({
      url: `${TEST_CONFIG.address}/rpc`,
      namespace: TEST_CONFIG.ns,
      database: TEST_CONFIG.db,
      auth: {
        username: TEST_CONFIG.username,
        password: TEST_CONFIG.password,
      },
    });

    // Setup DB - ensure tables exist and are clean
    await rawDb.query(`
      DEFINE NAMESPACE IF NOT EXISTS ${TEST_CONFIG.ns};
      DEFINE DATABASE IF NOT EXISTS ${TEST_CONFIG.db};
      DELETE user;
      DELETE session;
      DELETE account;
      DELETE organization;
      DELETE member;
      DELETE team;
      DELETE invitation;
    `);

    // Create auth instance with plugins
    auth = betterAuth({
      baseURL: "http://localhost:3000",
      database: surrealAdapter({
        ...TEST_CONFIG,
        debugLogs: false,
      }),
      secret: "test-secret-for-plugins",
      emailAndPassword: { enabled: true },
      advanced: {
        disableCSRFCheck: true,
      },
      plugins: [
        admin({ defaultRole: "user" }),
        organization({
          teams: { enabled: true },
        }),
      ],
    });

    // Create client with custom fetch that routes to auth handler
    const customFetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(url.toString(), init);
      return auth.handler(req);
    };

    client = createAuthClient({
      baseURL: "http://localhost:3000/api/auth",
      fetchOptions: {
        customFetchImpl,
      },
    });

    // Sign up test user
    await auth.api.signUpEmail({ body: testUser });
  });

  afterAll(async () => {
    if (rawDb) {
      await rawDb.query("DELETE user; DELETE session; DELETE account; DELETE organization; DELETE member; DELETE team; DELETE invitation;");
      await rawDb.close();
    }
  });

  it("should sign in and get session with user populated", async () => {
    const headers = new Headers();
    await client.signIn.email(
      {
        email: testUser.email,
        password: testUser.password,
      },
      {
        onSuccess: sessionSetter(headers),
      },
    );

    const { data: session } = await client.getSession({
      fetchOptions: { headers },
    });

    expect(session).toBeDefined();
    expect(session?.user).toBeDefined();
    expect(session?.user?.email).toBe(testUser.email);
    expect(session?.user?.name).toBe(testUser.name);
    // Ensure user is populated (not empty)
    expect(Object.keys(session?.user || {}).length).toBeGreaterThan(0);
  });

  it("should create organization with organization plugin", async () => {
    const headers = new Headers();
    await client.signIn.email(
      {
        email: testUser.email,
        password: testUser.password,
      },
      {
        onSuccess: sessionSetter(headers),
      },
    );

    // Create organization using direct API call
    const orgResult = await auth.api.createOrganization({
      body: {
        name: "Test Organization",
        slug: `test-org-${timestamp}`,
      },
      headers,
    });

    expect(orgResult).toBeDefined();
    expect(orgResult.name).toBe("Test Organization");
    expect(orgResult.slug).toBe(`test-org-${timestamp}`);
    expect(orgResult.id).toBeDefined();
  });

  it("should list organizations", async () => {
    const headers = new Headers();
    await client.signIn.email(
      {
        email: testUser.email,
        password: testUser.password,
      },
      {
        onSuccess: sessionSetter(headers),
      },
    );

    const orgs = await auth.api.listOrganizations({ headers });

    expect(orgs).toBeDefined();
    expect(Array.isArray(orgs)).toBe(true);
    expect(orgs.length).toBeGreaterThanOrEqual(1);
    expect(orgs[0].name).toBe("Test Organization");
  });

  it("should verify organization membership was created", async () => {
    const headers = new Headers();
    await client.signIn.email(
      {
        email: testUser.email,
        password: testUser.password,
      },
      {
        onSuccess: sessionSetter(headers),
      },
    );

    // Get organizations - if we can list them, membership must exist
    const orgs = await auth.api.listOrganizations({ headers });
    expect(orgs.length).toBeGreaterThanOrEqual(1);

    // Verify org data is complete
    const org = orgs[0];
    expect(org.id).toBeDefined();
    expect(org.name).toBe("Test Organization");
    expect(org.slug).toBeDefined();
    expect(org.createdAt).toBeDefined();
  });

  it("should handle multiple sessions for same user", async () => {
    const headers1 = new Headers();
    const headers2 = new Headers();

    // First sign in
    await client.signIn.email(
      {
        email: testUser.email,
        password: testUser.password,
      },
      {
        onSuccess: sessionSetter(headers1),
      },
    );

    // Second sign in
    await client.signIn.email(
      {
        email: testUser.email,
        password: testUser.password,
      },
      {
        onSuccess: sessionSetter(headers2),
      },
    );

    // Both sessions should work and have same user
    const { data: session1 } = await client.getSession({
      fetchOptions: { headers: headers1 },
    });
    const { data: session2 } = await client.getSession({
      fetchOptions: { headers: headers2 },
    });

    expect(session1?.user.id).toBe(session2?.user.id);
    expect(session1?.user.email).toBe(testUser.email);
    expect(session2?.user.email).toBe(testUser.email);
  });

  it("should create second organization for same user", async () => {
    const headers = new Headers();
    await client.signIn.email(
      {
        email: testUser.email,
        password: testUser.password,
      },
      {
        onSuccess: sessionSetter(headers),
      },
    );

    // Create second organization
    const orgResult = await auth.api.createOrganization({
      body: {
        name: "Second Organization",
        slug: `second-org-${timestamp}`,
      },
      headers,
    });

    expect(orgResult).toBeDefined();
    expect(orgResult.name).toBe("Second Organization");

    // Should now have 2 organizations
    const orgs = await auth.api.listOrganizations({ headers });
    expect(orgs.length).toBe(2);
  });
});
