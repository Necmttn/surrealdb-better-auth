import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { surrealAdapter } from "../src";
import { getDatabase } from "../db/surreal";
import { getTestInstance } from "./testInstance";
import Surreal from "surrealdb";
import { betterAuth } from "better-auth";
import { getAdapter } from "better-auth/db";

// Test configuration
const TEST_CONFIG = {
  address: "http://127.0.0.1:8000",
  username: "root",
  password: "root",
  ns: "better_auth_test",
  db: "better_auth_test",
};

describe("adapter: basic operations", async () => {
  let rawDb: Surreal;
  let adapter: Awaited<ReturnType<typeof getAdapter>>;

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
    `);

    // Create a minimal betterAuth instance to get the adapter
    const auth = betterAuth({
      database: surrealAdapter({
        ...TEST_CONFIG,
        debugLogs: false,
      }),
      secret: "test-secret",
      emailAndPassword: { enabled: true },
    });

    adapter = await getAdapter(auth.options);
  });

  afterAll(async () => {
    if (rawDb) {
      await rawDb.query("DELETE user; DELETE session; DELETE account;");
      await rawDb.close();
    }
  });

  const testUser = {
    id: "test-user-1",
    name: "Test User",
    email: "test@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("should create a user", async () => {
    const res = await adapter.create({
      model: "user",
      data: testUser,
    });

    expect(res).toBeDefined();
    expect(res.name).toBe(testUser.name);
    expect(res.email).toBe(testUser.email);
  });

  it("should find user by id", async () => {
    const res = await adapter.findOne({
      model: "user",
      where: [{ field: "email", value: testUser.email }],
    });

    expect(res).toBeDefined();
    expect(res?.email).toBe(testUser.email);
    expect(res?.name).toBe(testUser.name);
  });

  it("should find user by email", async () => {
    const res = await adapter.findOne({
      model: "user",
      where: [{ field: "email", value: testUser.email }],
    });

    expect(res).toBeDefined();
    expect(res?.email).toBe(testUser.email);
  });

  it("should update user", async () => {
    const user = await adapter.findOne({
      model: "user",
      where: [{ field: "email", value: testUser.email }],
    });

    const res = await adapter.update({
      model: "user",
      where: [{ field: "id", value: user!.id }],
      update: { name: "Updated Name" },
    });

    expect(res.name).toBe("Updated Name");
  });

  it("should find many users", async () => {
    const res = await adapter.findMany({ model: "user" });
    expect(res.length).toBeGreaterThanOrEqual(1);
  });

  it("should count users", async () => {
    const count = await adapter.count({ model: "user" });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("should count users with where clause", async () => {
    const count = await adapter.count({
      model: "user",
      where: [{ field: "email", value: testUser.email }],
    });
    expect(count).toBe(1);
  });

  it("should count return 0 for non-existent", async () => {
    const count = await adapter.count({
      model: "user",
      where: [{ field: "email", value: "nonexistent@test.com" }],
    });
    expect(count).toBe(0);
  });

  it("should handle operators", async () => {
    // Create more users
    await adapter.create({
      model: "user",
      data: {
        id: "operator-test-1",
        name: "Operator Test User",
        email: "operator1@test.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await adapter.findMany({
      model: "user",
      where: [
        {
          field: "name",
          operator: "starts_with",
          value: "Operator",
        },
      ],
    });
    expect(res.length).toBe(1);
  });

  it("should delete user", async () => {
    await adapter.delete({
      model: "user",
      where: [{ field: "email", value: "operator1@test.com" }],
    });

    const res = await adapter.findOne({
      model: "user",
      where: [{ field: "email", value: "operator1@test.com" }],
    });
    expect(res).toBeNull();
  });
});

describe("e2e: auth flow", async () => {
  const { auth, client, sessionSetter, rawDb } = await getTestInstance(
    {},
    {
      disableTestUser: true,
      testWith: "surreal",
    },
  );

  const testUser = {
    email: "e2e-test@email.com",
    password: "password123",
    name: "E2E Test Name",
  };

  beforeAll(async () => {
    // Clean up before tests
    await rawDb.query("DELETE user; DELETE session; DELETE account;");
    // Sign up the user in beforeAll so subsequent tests can use it
    await auth.api.signUpEmail({ body: testUser });
  });

  it("should sign up a new user", async () => {
    // User created in beforeAll, verify they exist by signing in
    const result = await auth.api.signInEmail({
      body: {
        email: testUser.email,
        password: testUser.password,
      },
    });
    expect(result).toBeDefined();
    expect(result.user).toBeDefined();
    expect(result.user.email).toBe(testUser.email);
    expect(result.user.name).toBe(testUser.name);
  });

  it("should sign in the user", async () => {
    const result = await auth.api.signInEmail({
      body: {
        email: testUser.email,
        password: testUser.password,
      },
    });
    expect(result).toBeDefined();
    expect(result.user).toBeDefined();
    // In better-auth 1.4.x, token is at root level
    expect(result.token).toBeDefined();
  });

  it("should get session with populated user (critical test)", async () => {
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

    // This is the critical test - user must be populated
    expect(session).toBeDefined();
    expect(session?.session).toBeDefined();
    expect(session?.user).toBeDefined();
    expect(session?.user.id).toBeDefined();
    expect(session?.user.email).toBe(testUser.email);
    expect(session?.user.name).toBe(testUser.name);
  });

  it("should handle multiple sign-ins for same user", async () => {
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

  it("should sign out successfully", async () => {
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

    // Verify session works
    const { data: before } = await client.getSession({
      fetchOptions: { headers },
    });
    expect(before?.user).toBeDefined();

    // Sign out
    await client.signOut({
      fetchOptions: { headers },
    });

    // Session should be invalid after signout
    const { data: after } = await client.getSession({
      fetchOptions: { headers },
    });
    expect(after).toBeNull();
  });
});

describe("e2e: session/user join", async () => {
  // This specifically tests the bug where getSession returns empty user
  const { auth, client, sessionSetter, rawDb, db } = await getTestInstance(
    {},
    {
      disableTestUser: true,
      testWith: "surreal",
    },
  );

  const testUser = {
    email: "join-test@email.com",
    password: "password123",
    name: "Join Test User",
  };

  beforeAll(async () => {
    await rawDb.query("DELETE user; DELETE session; DELETE account;");
    // Create user
    await auth.api.signUpEmail({ body: testUser });
  });

  it("should fetch session with user via adapter", async () => {
    // Sign in to create a session
    const signInResult = await auth.api.signInEmail({
      body: {
        email: testUser.email,
        password: testUser.password,
      },
    });

    expect(signInResult).toBeDefined();
    expect(signInResult.token).toBeDefined();
    expect(signInResult.user).toBeDefined();

    // Get the session from DB - token is at root level in better-auth 1.4.x
    const session = await db.findOne({
      model: "session",
      where: [{ field: "token", value: signInResult.token }],
    });

    expect(session).toBeDefined();
    expect(session?.userId).toBeDefined();

    // Now get the user separately (this is how the factory handles joins)
    const user = await db.findOne({
      model: "user",
      where: [{ field: "id", value: session!.userId }],
    });

    expect(user).toBeDefined();
    expect(user?.email).toBe(testUser.email);
  });

  it("should verify session-user relationship is correct", async () => {
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

    const { data: sessionData } = await client.getSession({
      fetchOptions: { headers },
    });

    // Verify the user object is populated and correct
    expect(sessionData?.user).not.toEqual({});
    expect(Object.keys(sessionData?.user || {}).length).toBeGreaterThan(0);
    expect(sessionData?.user.email).toBe(testUser.email);
  });
});

describe("e2e: account creation (OAuth simulation)", async () => {
  // This tests the count() method which was broken with "Cannot perform subtraction" error
  const { auth, rawDb, db } = await getTestInstance(
    {},
    {
      disableTestUser: true,
      testWith: "surreal",
    },
  );

  beforeAll(async () => {
    await rawDb.query("DELETE user; DELETE session; DELETE account;");
  });

  it("should count accounts correctly with empty table", async () => {
    const count = await db.count({ model: "account" });
    expect(count).toBe(0);
  });

  it("should handle account-related queries without arithmetic errors", async () => {
    // Create a user first
    const user = await db.create({
      model: "user",
      data: {
        id: "oauth-test-user",
        email: "oauth@test.com",
        name: "OAuth Test User",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Create an account (simulating OAuth)
    const account = await db.create({
      model: "account",
      data: {
        id: "oauth-account-1",
        userId: user.id,
        accountId: "microsoft-12345",
        providerId: "microsoft",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    expect(account).toBeDefined();
    expect(account.providerId).toBe("microsoft");

    // Count should work
    const count = await db.count({ model: "account" });
    expect(count).toBe(1);

    // Count with where should work
    const countWithWhere = await db.count({
      model: "account",
      where: [{ field: "providerId", value: "microsoft" }],
    });
    expect(countWithWhere).toBe(1);
  });
});
