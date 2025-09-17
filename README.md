# SurrealDB Adapter for Better Auth

[![npm version](https://badge.fury.io/js/surrealdb-better-auth.svg)](https://badge.fury.io/js/surrealdb-better-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A seamless integration between [SurrealDB](https://surrealdb.com) and
[Better Auth](https://better-auth.com), providing a robust authentication
solution with the power of SurrealDB's flexible database capabilities.

## ✨ Features

- 🔐 Secure authentication with SurrealDB
- 🔄 Real-time data synchronization
- 🚀 High performance and scalability
- 🔧 Easy configuration and setup
- 📦 TypeScript support
- 🧩 Flexible integration options

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ or Bun
- SurrealDB instance (local or cloud)
- Better Auth setup

### Installation

```bash
# Using pnpm (recommended)
pnpm add surrealdb-better-auth

# Using npm
npm install surrealdb-better-auth

# Using yarn
yarn add surrealdb-better-auth
```

## 🛠️ Configuration

### Basic Setup

```typescript
import { surrealAdapter } from "surrealdb-better-auth";
import { Surreal } from 'surrealdb'

const surrealdb = new Surreal()
surrealdb.connect(
	process.env.SURREALDB_ADDRESS ?? "http://localhost:8000", {
	namespace: process.env.SURREALDB_NAMESPACE ?? "namespace",
	database: process.env.SURREALDB_DATABASE ?? "database",
	auth: {
		username: process.env.SURREALDB_AUTH_USERNAME ?? "root",
		password: process.env.SURREALDB_AUTH_PASSWORD ??"root",
	},
	reconnect: true,
})

export const auth = betterAuth({
	// ... other Better Auth options
	database: surrealAdapter(surrealdb),
});
```

## 📋 Schema Generation

You can automatically run to generate a schema based on your configuration to a Surql file.

```sh
npx @better-auth/cli generate
```

You can also perform this in javascript to print to console:

```typescript
const adapterFunc = surrealAdapter(surreal);

_auth = betterAuth({
	// ... other Better Auth options
	database: surrealFunc,
	plugins: [
		// ... works with plugins too
	]
});

const adapter = adapterFunc(_auth.options);
const schema = await adapter.createSchema!(_auth.options);
console.log(schema.code);
```

## 🆓 Free SurrealDB Cloud Instance

Get started with a free SurrealDB Cloud instance:
[Sign up here](https://surrealist.app/referral?code=xeoimhrajt3xk3be) (I get a
bonus if you sign up via this link)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file
for details.
