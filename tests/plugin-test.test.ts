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

describe("e2e: invitation flow", async () => {
  let rawDb: Surreal;
  let auth: ReturnType<typeof betterAuth>;
  let client: ReturnType<typeof createAuthClient>;
  const timestamp = Date.now();

  const ownerUser = {
    email: `owner-${timestamp}@example.com`,
    password: "password123",
    name: "Owner User",
  };

  const invitedUser = {
    email: `invited-${timestamp}@example.com`,
    password: "password123",
    name: "Invited User",
  };

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

    auth = betterAuth({
      baseURL: "http://localhost:3000",
      database: surrealAdapter({
        ...TEST_CONFIG,
        debugLogs: false,
      }),
      secret: "test-secret-for-invitations",
      emailAndPassword: { enabled: true },
      advanced: {
        disableCSRFCheck: true,
      },
      plugins: [
        admin({ defaultRole: "user" }),
        organization({
          teams: { enabled: true },
          invitationExpiresIn: 60 * 60 * 24, // 24 hours
        }),
      ],
    });

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

    // Create both users
    await auth.api.signUpEmail({ body: ownerUser });
    await auth.api.signUpEmail({ body: invitedUser });
  });

  afterAll(async () => {
    if (rawDb) {
      await rawDb.query("DELETE user; DELETE session; DELETE account; DELETE organization; DELETE member; DELETE team; DELETE invitation;");
      await rawDb.close();
    }
  });

  it("should create invitation for new user", async () => {
    const headers = new Headers();
    await client.signIn.email(
      {
        email: ownerUser.email,
        password: ownerUser.password,
      },
      {
        onSuccess: sessionSetter(headers),
      },
    );

    // Create organization first
    const orgResult = await auth.api.createOrganization({
      body: {
        name: "Invitation Test Org",
        slug: `invite-org-${timestamp}`,
      },
      headers,
    });

    expect(orgResult).toBeDefined();
    expect(orgResult.id).toBeDefined();

    // Create invitation
    const invitation = await auth.api.createInvitation({
      body: {
        email: invitedUser.email,
        role: "member",
        organizationId: orgResult.id,
      },
      headers,
    });

    expect(invitation).toBeDefined();
    expect(invitation.email).toBe(invitedUser.email);
    expect(invitation.role).toBe("member");
    expect(invitation.organizationId).toBe(orgResult.id);
    expect(invitation.status).toBe("pending");
    expect(invitation.id).toBeDefined();
  });

  it("should list pending invitations for organization", async () => {
    const headers = new Headers();
    await client.signIn.email(
      {
        email: ownerUser.email,
        password: ownerUser.password,
      },
      {
        onSuccess: sessionSetter(headers),
      },
    );

    // Get organization
    const orgs = await auth.api.listOrganizations({ headers });
    const org = orgs[0];

    // List invitations
    const invitations = await auth.api.listInvitations({
      query: { organizationId: org.id },
      headers,
    });

    expect(invitations).toBeDefined();
    expect(Array.isArray(invitations)).toBe(true);
    expect(invitations.length).toBeGreaterThanOrEqual(1);
    expect(invitations.some((i: { email: string }) => i.email === invitedUser.email)).toBe(true);
  });

  it("should accept invitation", async () => {
    const ownerHeaders = new Headers();
    await client.signIn.email(
      {
        email: ownerUser.email,
        password: ownerUser.password,
      },
      {
        onSuccess: sessionSetter(ownerHeaders),
      },
    );

    // Get the pending invitation
    const orgs = await auth.api.listOrganizations({ headers: ownerHeaders });
    const org = orgs[0];
    const invitations = await auth.api.listInvitations({
      query: { organizationId: org.id },
      headers: ownerHeaders,
    });

    const pendingInvitation = invitations.find((i: { email: string; status: string }) =>
      i.email === invitedUser.email && i.status === "pending"
    );
    expect(pendingInvitation).toBeDefined();

    // Sign in as invited user
    const invitedHeaders = new Headers();
    await client.signIn.email(
      {
        email: invitedUser.email,
        password: invitedUser.password,
      },
      {
        onSuccess: sessionSetter(invitedHeaders),
      },
    );

    // Accept the invitation
    const acceptResult = await auth.api.acceptInvitation({
      body: {
        invitationId: pendingInvitation.id,
      },
      headers: invitedHeaders,
    });

    expect(acceptResult).toBeDefined();

    // Verify invited user can now see the organization
    const invitedOrgs = await auth.api.listOrganizations({ headers: invitedHeaders });
    expect(invitedOrgs.some((o: { id: string }) => o.id === org.id)).toBe(true);
  });

  it("should show both users as members after invitation accepted", async () => {
    const headers = new Headers();
    await client.signIn.email(
      {
        email: ownerUser.email,
        password: ownerUser.password,
      },
      {
        onSuccess: sessionSetter(headers),
      },
    );

    // Get organization
    const orgs = await auth.api.listOrganizations({ headers });
    const org = orgs[0];

    // Get full organization with members
    const fullOrg = await auth.api.getFullOrganization({
      query: { organizationId: org.id },
      headers,
    });

    expect(fullOrg.members.length).toBeGreaterThanOrEqual(2);

    // Owner should be present with owner role
    const ownerMember = fullOrg.members.find((m: { user?: { email?: string } }) =>
      m.user?.email === ownerUser.email
    );
    expect(ownerMember).toBeDefined();
    expect(ownerMember?.role).toBe("owner");

    // Invited user should be present with member role
    const invitedMember = fullOrg.members.find((m: { user?: { email?: string } }) =>
      m.user?.email === invitedUser.email
    );
    expect(invitedMember).toBeDefined();
    expect(invitedMember?.role).toBe("member");
  });
});
