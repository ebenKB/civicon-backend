# Auth & Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let actors sign up and sign in, and make the server able to tell — and enforce — what kind of user each authenticated request belongs to.

**Architecture:** A `Role` enum in a new `src/contracts/` folder is the single source of truth. The `User` schema gains `passwordHash` (never selected by default), `roles[]`, `civicPointsCached` and `reputation`. `AuthService` issues a signed JWT whose claims carry the user's roles; two globally registered guards (`JwtAuthGuard` then `RolesGuard`) make every route default-deny, with `@Public()` as the explicit opt-out and `@Roles()` as the per-route requirement. `GET /auth/me` re-reads the database so a client can pick up a role change without re-logging-in.

**Tech Stack:** NestJS 12 (ESM), Mongoose 9, `@nestjs/jwt`, `bcryptjs`, `class-validator`, Vitest (unit + e2e), MongoDB 8.

**Spec:** `docs/superpowers/specs/2026-09-13-auth-identity-design.md`

## Global Constraints

- **ESM codebase.** `package.json` has `"type": "module"` and tsconfig uses `nodenext`. Every relative import MUST carry a `.js` extension, even when importing a `.ts` file: `import { User } from './schemas/user.schema.js';`
- **Node 24, TypeScript 6, `strict: true`, `strictPropertyInitialization: false`** (so Nest's `@Prop()` class fields need no `!`).
- **Global pipe already registered** in `AppModule`: `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`. Any property not declared with a `class-validator` decorator on the DTO produces a 400. Do not register another.
- **Global filter already registered:** `MongoExceptionFilter` maps `CastError` → 400, `ValidationError` → 400, duplicate key (11000) → 409. Do not hand-roll duplicate-email handling.
- **New dependencies are limited to exactly:** `@nestjs/jwt`, `bcryptjs`, and `@types/bcryptjs` if needed. Do **not** add `passport`, `@nestjs/passport`, or `passport-jwt`.
- **Vitest globals are on** (`describe`, `it`, `expect`, `vi` need no import). Unit specs live beside their source as `*.spec.ts`; e2e specs live in `test/` as `*.e2e-spec.ts`.
- **e2e tests need a running database:** `docker compose up -d` first. The suite refuses to run unless the connected database name ends in `_test`.
- **Bcrypt cost factor is 12.** Password max length is 72 bytes (bcrypt truncates beyond that).
- **The single 401 message for every failed login is the exact string `Invalid credentials`** — unknown email, wrong password and inactive account must be indistinguishable.
- **`VOLUNTEER` implies `CITIZEN`.** `AGENCY`, `SPONSOR` and `ADMIN` imply nothing.
- Run `npm run format` and `npm run lint` before each commit.

---

### Task 1: Role contract and user schema

Establishes the `Role` enum every later task imports, and widens the `User` document to carry credentials and roles.

**Files:**
- Create: `src/contracts/role.ts`
- Create: `src/contracts/role.spec.ts`
- Create: `src/contracts/index.ts`
- Modify: `src/users/schemas/user.schema.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Role` enum (`CITIZEN` | `VOLUNTEER` | `AGENCY` | `SPONSOR` | `ADMIN`); `PUBLIC_ROLES: readonly Role[]`; `applyRoleImplications(roles: Role[]): Role[]`; the `User` class with new fields `passwordHash: string`, `roles: Role[]`, `civicPointsCached: number`, `reputation: number`.

- [ ] **Step 1: Write the failing test**

Create `src/contracts/role.spec.ts`:

```ts
import { applyRoleImplications, PUBLIC_ROLES, Role } from './role.js';

describe('PUBLIC_ROLES', () => {
  it('contains only the self-serve roles', () => {
    expect([...PUBLIC_ROLES]).toEqual([Role.CITIZEN, Role.VOLUNTEER]);
  });

  it.each([Role.AGENCY, Role.SPONSOR, Role.ADMIN])(
    'excludes the privileged role %s',
    (role) => {
      expect(PUBLIC_ROLES).not.toContain(role);
    },
  );
});

describe('applyRoleImplications', () => {
  it('adds CITIZEN when VOLUNTEER is granted', () => {
    expect(applyRoleImplications([Role.VOLUNTEER])).toEqual([
      Role.VOLUNTEER,
      Role.CITIZEN,
    ]);
  });

  it('leaves an existing CITIZEN + VOLUNTEER pair untouched', () => {
    expect(applyRoleImplications([Role.CITIZEN, Role.VOLUNTEER])).toEqual([
      Role.CITIZEN,
      Role.VOLUNTEER,
    ]);
  });

  it('does not add CITIZEN to privileged roles', () => {
    expect(applyRoleImplications([Role.AGENCY])).toEqual([Role.AGENCY]);
    expect(applyRoleImplications([Role.ADMIN])).toEqual([Role.ADMIN]);
  });

  it('de-duplicates repeated roles', () => {
    expect(applyRoleImplications([Role.CITIZEN, Role.CITIZEN])).toEqual([
      Role.CITIZEN,
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/contracts/role.spec.ts`
Expected: FAIL — cannot resolve `./role.js`.

- [ ] **Step 3: Write the contract**

Create `src/contracts/role.ts`:

```ts
/**
 * The platform's actor types. Verbatim from the execution guide §4.1 — this is
 * the single source of truth; never redefine these strings locally.
 */
export enum Role {
  CITIZEN = 'CITIZEN',
  VOLUNTEER = 'VOLUNTEER',
  AGENCY = 'AGENCY',
  SPONSOR = 'SPONSOR',
  ADMIN = 'ADMIN',
}

/**
 * Roles a user may grant themselves at registration. AGENCY, SPONSOR and ADMIN
 * are deliberately absent: agencies are the authoritative owners of issues, so
 * that authority cannot be self-assigned by anyone who can reach the signup
 * form. They are created by the seed or by an admin.
 */
export const PUBLIC_ROLES: readonly Role[] = [Role.CITIZEN, Role.VOLUNTEER];

/**
 * A volunteer is a citizen who also does the work — there is no coherent actor
 * who can fix a problem but not report one. Granting VOLUNTEER therefore grants
 * CITIZEN too. The privileged roles are orthogonal to citizenship and imply
 * nothing.
 */
export function applyRoleImplications(roles: Role[]): Role[] {
  const result = new Set<Role>(roles);
  if (result.has(Role.VOLUNTEER)) {
    result.add(Role.CITIZEN);
  }
  return [...result];
}
```

Create `src/contracts/index.ts`:

```ts
export * from './role.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/contracts/role.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Widen the user schema**

Replace `src/users/schemas/user.schema.ts` entirely with:

```ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Role } from '../../contracts/index.js';

export type UserDocument = HydratedDocument<User>;

@Schema({
  timestamps: true,
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      ret.id = ret._id;
      delete ret._id;
      // Second line of defence. `select: false` already keeps the hash out of
      // every query that does not explicitly ask for it; this makes a leak
      // impossible even if some future code does ask.
      delete ret.passwordHash;
      return ret;
    },
  },
})
export class User {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  // Never returned by a plain find(); only `.select('+passwordHash')` retrieves
  // it, and that appears in exactly one place (UsersService.findByEmailWithPassword).
  @Prop({ required: true, select: false })
  passwordHash: string;

  @Prop({
    type: [String],
    enum: Object.values(Role),
    default: [Role.CITIZEN],
  })
  roles: Role[];

  // A cache, per execution guide §4.3: the truth is the sum of
  // point_transactions. Nothing in the auth slice writes to it.
  @Prop({ default: 0 })
  civicPointsCached: number;

  @Prop({ default: 100 })
  reputation: number;

  @Prop({ default: true })
  isActive: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
```

- [ ] **Step 6: Verify the project still compiles**

Run: `npx tsc --noEmit`
Expected: clean, or at most complaints in `src/users/users.service.ts` / `src/seed.ts` about `passwordHash` — Mongoose's `create()` and `Partial<User>` typings are loose enough that both usually pass. Tasks 3, 5 and 6 rewrite those call sites either way. An error in any OTHER file means the schema edit is wrong: stop and re-read this step.

Note: existing user documents in the database now violate `required: true`. That is expected; Task 6 reseeds.

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint
git add src/contracts src/users/schemas/user.schema.ts
git commit -m "Add Role contract and extend the user schema for auth"
```

---

### Task 2: Password hashing

An isolated service so the hashing algorithm can be swapped without touching authentication logic.

**Files:**
- Create: `src/auth/password.service.ts`
- Create: `src/auth/password.service.spec.ts`
- Modify: `package.json` (dependencies)

**Interfaces:**
- Consumes: nothing.
- Produces: `PasswordService` with `hash(plain: string): Promise<string>` and `compare(plain: string, hash: string): Promise<boolean>`.

- [ ] **Step 1: Install the dependencies**

```bash
npm install @nestjs/jwt bcryptjs
npx tsc --noEmit 2>&1 | grep -i "bcryptjs" || echo "bcryptjs types OK"
```

If that grep printed a "could not find a declaration file" error, run `npm install --save-dev @types/bcryptjs`. Recent `bcryptjs` bundles its own types, so this is usually unnecessary.

- [ ] **Step 2: Write the failing test**

Create `src/auth/password.service.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PasswordService],
    }).compile();

    service = module.get<PasswordService>(PasswordService);
  });

  it('produces a hash that is not the plaintext', async () => {
    const hash = await service.hash('correct horse battery');

    expect(hash).not.toBe('correct horse battery');
    expect(hash.length).toBeGreaterThan(20);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const [first, second] = await Promise.all([
      service.hash('same-password'),
      service.hash('same-password'),
    ]);

    expect(first).not.toBe(second);
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('correct horse battery');

    await expect(service.compare('correct horse battery', hash)).resolves.toBe(
      true,
    );
  });

  it('rejects a wrong password', async () => {
    const hash = await service.hash('correct horse battery');

    await expect(service.compare('wrong password', hash)).resolves.toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/auth/password.service.spec.ts`
Expected: FAIL — cannot resolve `./password.service.js`.

- [ ] **Step 4: Write the implementation**

Create `src/auth/password.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';

/** Tuned for a demo-scale deployment; raise if hardware allows. */
const COST_FACTOR = 12;

/**
 * Isolated from AuthService so the algorithm is a one-file change. bcryptjs is
 * pure JavaScript, so the Docker image needs no build toolchain.
 */
@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, COST_FACTOR);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/auth/password.service.spec.ts`
Expected: PASS (4 tests). Cost factor 12 makes each hash take roughly a quarter-second, so the file takes a few seconds.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add package.json package-lock.json src/auth/password.service.ts src/auth/password.service.spec.ts
git commit -m "Add PasswordService with bcrypt hashing"
```

---

### Task 3: Registration and login

Delivers `POST /auth/register` and `POST /auth/login`. Routes are still unguarded at the end of this task — Task 4 adds the guards.

**Files:**
- Create: `src/auth/types/jwt-payload.ts`
- Create: `src/auth/dto/register.dto.ts`
- Create: `src/auth/dto/login.dto.ts`
- Create: `src/users/user-response.ts`
- Create: `src/auth/auth.service.ts`
- Create: `src/auth/auth.service.spec.ts`
- Create: `src/auth/auth.controller.ts`
- Create: `src/auth/auth.module.ts`
- Modify: `src/users/users.service.ts`
- Modify: `src/users/users.service.spec.ts`
- Modify: `src/app.module.ts`
- Modify: `.env`, `.env.example`

**Interfaces:**
- Consumes: `Role`, `PUBLIC_ROLES`, `applyRoleImplications` (Task 1); `PasswordService.hash` / `.compare` (Task 2); `UserDocument` (Task 1).
- Produces: `JwtPayload { sub: string; email: string; roles: Role[] }`; `AuthenticatedUser { id: string; email: string; roles: Role[] }`; `PublicUser` and `toPublicUser(user: UserDocument): PublicUser`; `AuthResponse { token: string; user: PublicUser }`; `AuthService.register(dto)`, `AuthService.login(dto)`, `AuthService.validateCredentials(email, password)`; `UsersService.createWithPassword(input)`, `UsersService.findByEmailWithPassword(email)`, `UsersService.setRoles(id: string, roles: Role[]): Promise<UserDocument>`; `AuthModule` (exports `PasswordService` and `JwtModule`).

- [ ] **Step 1: Add the JWT configuration to the environment files**

Append to both `.env` and `.env.example`:

```
# --- Auth ---
# No default is provided on purpose: a fallback development secret is exactly
# the secret that reaches production. The app refuses to boot without this.
# Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=
JWT_EXPIRES_IN=7d
```

Then give `.env` (only — `.env.example` keeps the empty value) a real secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Paste the output after `JWT_SECRET=` in `.env`.

- [ ] **Step 2: Write the shared types and the response shaper**

Create `src/auth/types/jwt-payload.ts`:

```ts
import { Role } from '../../contracts/index.js';

/** The claims carried by an access token. `sub` is the user id. */
export interface JwtPayload {
  sub: string;
  email: string;
  roles: Role[];
}

/** What the guards attach to `request.user`, built from the claims alone. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  roles: Role[];
}
```

Create `src/users/user-response.ts`:

```ts
import { Role } from '../contracts/index.js';
import { UserDocument } from './schemas/user.schema.js';

/** The user shape the API returns. Deliberately explicit: adding a field to the
 *  schema must not silently widen what the API exposes. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  civicPointsCached: number;
  reputation: number;
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    roles: user.roles,
    civicPointsCached: user.civicPointsCached,
    reputation: user.reputation,
  };
}
```

- [ ] **Step 3: Write the DTOs**

Create `src/auth/dto/register.dto.ts`:

```ts
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PUBLIC_ROLES, Role } from '../../contracts/index.js';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  // bcrypt silently truncates past 72 bytes, so a longer password would have
  // meaningless trailing characters. Rejecting is more honest than truncating.
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  // Requesting AGENCY, SPONSOR or ADMIN fails here, before any service code
  // runs. Those roles come from the seed or from an admin grant.
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(PUBLIC_ROLES, { each: true })
  roles?: Role[];
}
```

Create `src/auth/dto/login.dto.ts`:

```ts
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}
```

- [ ] **Step 4: Write the failing AuthService test**

Create `src/auth/auth.service.spec.ts`:

```ts
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '../contracts/index.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';

/** A stand-in for a hydrated Mongoose document, with only the fields read. */
const userDoc = (overrides: Record<string, unknown> = {}) => ({
  _id: { toString: () => '507f1f77bcf86cd799439011' },
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  passwordHash: 'hashed',
  roles: [Role.CITIZEN],
  civicPointsCached: 0,
  reputation: 100,
  isActive: true,
  ...overrides,
});

describe('AuthService', () => {
  let service: AuthService;
  let usersService: {
    createWithPassword: ReturnType<typeof vi.fn>;
    findByEmailWithPassword: ReturnType<typeof vi.fn>;
  };
  let passwordService: {
    hash: ReturnType<typeof vi.fn>;
    compare: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    usersService = {
      createWithPassword: vi.fn(),
      findByEmailWithPassword: vi.fn(),
    };
    passwordService = { hash: vi.fn(), compare: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: PasswordService, useValue: passwordService },
        { provide: JwtService, useValue: new JwtService({ secret: 'test' }) },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('register', () => {
    it('hashes the password and never stores the plaintext', async () => {
      passwordService.hash.mockResolvedValue('hashed');
      usersService.createWithPassword.mockResolvedValue(userDoc());

      await service.register({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret',
      });

      expect(passwordService.hash).toHaveBeenCalledWith('super-secret');
      const [input] = usersService.createWithPassword.mock.calls[0];
      expect(input.passwordHash).toBe('hashed');
      expect(JSON.stringify(input)).not.toContain('super-secret');
    });

    it('defaults roles to CITIZEN', async () => {
      passwordService.hash.mockResolvedValue('hashed');
      usersService.createWithPassword.mockResolvedValue(userDoc());

      await service.register({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret',
      });

      const [input] = usersService.createWithPassword.mock.calls[0];
      expect(input.roles).toEqual([Role.CITIZEN]);
    });

    it('normalizes a VOLUNTEER-only request to include CITIZEN', async () => {
      passwordService.hash.mockResolvedValue('hashed');
      usersService.createWithPassword.mockResolvedValue(
        userDoc({ roles: [Role.VOLUNTEER, Role.CITIZEN] }),
      );

      await service.register({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret',
        roles: [Role.VOLUNTEER],
      });

      const [input] = usersService.createWithPassword.mock.calls[0];
      expect(input.roles).toEqual([Role.VOLUNTEER, Role.CITIZEN]);
    });

    it('returns a token plus a sanitized user', async () => {
      passwordService.hash.mockResolvedValue('hashed');
      usersService.createWithPassword.mockResolvedValue(userDoc());

      const result = await service.register({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret',
      });

      expect(result.token).toEqual(expect.any(String));
      expect(result.user).toEqual({
        id: '507f1f77bcf86cd799439011',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        roles: [Role.CITIZEN],
        civicPointsCached: 0,
        reputation: 100,
      });
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('signs the roles into the token claims', async () => {
      passwordService.hash.mockResolvedValue('hashed');
      usersService.createWithPassword.mockResolvedValue(
        userDoc({ roles: [Role.CITIZEN, Role.VOLUNTEER] }),
      );

      const { token } = await service.register({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret',
        roles: [Role.VOLUNTEER],
      });

      const claims = new JwtService({ secret: 'test' }).verify(token);
      expect(claims.sub).toBe('507f1f77bcf86cd799439011');
      expect(claims.email).toBe('ada@example.com');
      expect(claims.roles).toEqual([Role.CITIZEN, Role.VOLUNTEER]);
    });
  });

  describe('login', () => {
    it('returns a token for correct credentials', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue(userDoc());
      passwordService.compare.mockResolvedValue(true);

      const result = await service.login({
        email: 'ada@example.com',
        password: 'super-secret',
      });

      expect(result.token).toEqual(expect.any(String));
      expect(result.user.email).toBe('ada@example.com');
    });

    // The three failure modes must be indistinguishable, so the endpoint
    // cannot be used to discover which email addresses are registered.
    it.each([
      [
        'unknown email',
        () => usersService.findByEmailWithPassword.mockResolvedValue(null),
      ],
      [
        'wrong password',
        () => {
          usersService.findByEmailWithPassword.mockResolvedValue(userDoc());
          passwordService.compare.mockResolvedValue(false);
        },
      ],
      [
        'inactive account',
        () => {
          usersService.findByEmailWithPassword.mockResolvedValue(
            userDoc({ isActive: false }),
          );
          passwordService.compare.mockResolvedValue(true);
        },
      ],
    ])('rejects %s with the same message', async (_label, arrange) => {
      arrange();

      await expect(
        service.login({ email: 'ada@example.com', password: 'nope' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid credentials'));
    });
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run src/auth/auth.service.spec.ts`
Expected: FAIL — cannot resolve `./auth.service.js`.

- [ ] **Step 6: Add the UsersService methods the AuthService needs**

In `src/users/users.service.ts`: add `import { applyRoleImplications, Role } from '../contracts/index.js';` and add the three methods below.

**Leave the existing `create(createUserDto)` method in place for now.** `UsersController` still calls it; the route and the method are removed together in Task 5. Deleting it here would break the build in the middle of this task.

```ts
  /**
   * The ONLY place in the codebase that selects the password hash. Keep it that
   * way — `select: false` on the schema is what makes every other query safe.
   */
  findByEmailWithPassword(email: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({ email: email.toLowerCase() })
      .select('+passwordHash')
      .exec();
  }

  createWithPassword(input: {
    name: string;
    email: string;
    passwordHash: string;
    roles: Role[];
  }): Promise<UserDocument> {
    return this.userModel.create(input);
  }

  /**
   * Replace semantics: the supplied array becomes the user's roles, so this
   * both grants and revokes. Role implications are applied on the way in.
   */
  async setRoles(id: string, roles: Role[]): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(
        id,
        { roles: applyRoleImplications(roles) },
        { returnDocument: 'after', runValidators: true },
      )
      .exec();
    if (!user) {
      throw new NotFoundException(`User with id "${id}" not found`);
    }
    return user;
  }
```

In `src/users/users.service.spec.ts`: add `findOne: vi.fn()` to the `model` object and to its inline type declaration, import `Role` from `../contracts/index.js`, and add these two tests:

```ts
  it('finds a user by email with the password hash', async () => {
    const select = vi.fn().mockReturnValue(execOf({ email: 'ada@example.com' }));
    model.findOne.mockReturnValue({ select });

    await expect(
      service.findByEmailWithPassword('ADA@example.com'),
    ).resolves.toMatchObject({ email: 'ada@example.com' });

    // Lower-cased to match the schema's `lowercase: true` normalisation.
    expect(model.findOne).toHaveBeenCalledWith({ email: 'ada@example.com' });
    expect(select).toHaveBeenCalledWith('+passwordHash');
  });

  it('applies role implications when setting roles', async () => {
    model.findByIdAndUpdate.mockReturnValue(execOf({ roles: [] }));

    await service.setRoles('507f1f77bcf86cd799439011', [Role.VOLUNTEER]);

    expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      { roles: [Role.VOLUNTEER, Role.CITIZEN] },
      { returnDocument: 'after', runValidators: true },
    );
  });
```

- [ ] **Step 7: Write the AuthService**

Create `src/auth/auth.service.ts`:

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { applyRoleImplications, Role } from '../contracts/index.js';
import { UserDocument } from '../users/schemas/user.schema.js';
import { PublicUser, toPublicUser } from '../users/user-response.js';
import { UsersService } from '../users/users.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { PasswordService } from './password.service.js';
import { JwtPayload } from './types/jwt-payload.js';

/**
 * One message for every failure mode. Distinguishing "no such user" from "wrong
 * password" turns the endpoint into an account-enumeration oracle.
 */
const INVALID_CREDENTIALS = 'Invalid credentials';

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const passwordHash = await this.passwordService.hash(dto.password);

    // A duplicate email surfaces as a 409 through MongoExceptionFilter.
    const user = await this.usersService.createWithPassword({
      name: dto.name,
      email: dto.email,
      passwordHash,
      roles: applyRoleImplications(dto.roles ?? [Role.CITIZEN]),
    });

    return this.buildResponse(user);
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.validateCredentials(dto.email, dto.password);
    return this.buildResponse(user);
  }

  async validateCredentials(
    email: string,
    password: string,
  ): Promise<UserDocument> {
    const user = await this.usersService.findByEmailWithPassword(email);

    // Note: returning early for an unknown email skips the bcrypt compare and
    // so is measurably faster. Closing that timing channel needs a dummy
    // compare; out of scope here, alongside the rate limiting in the spec's
    // known gaps.
    if (!user) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const matches = await this.passwordService.compare(
      password,
      user.passwordHash,
    );
    // Deactivated accounts fail identically: saying "deactivated" would confirm
    // the address is registered.
    if (!matches || !user.isActive) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return user;
  }

  private async buildResponse(user: UserDocument): Promise<AuthResponse> {
    const payload: JwtPayload = {
      sub: user._id.toString(),
      email: user.email,
      roles: user.roles,
    };

    return {
      token: await this.jwtService.signAsync(payload),
      user: toPublicUser(user),
    };
  }
}
```

- [ ] **Step 8: Write the controller and module**

Create `src/auth/auth.controller.ts`:

```ts
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('login')
  // 200, not the POST default of 201: logging in creates no resource.
  @HttpCode(HttpStatus.OK)
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }
}
```

Create `src/auth/auth.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        // Fail at boot rather than fall back to a development default: a
        // fallback secret is exactly the secret that reaches production.
        if (!secret) {
          throw new Error(
            'JWT_SECRET is not set. Refusing to start — see .env.example.',
          );
        }
        return {
          secret,
          signOptions: {
            expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '7d',
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService],
  // The guards (Task 4) need JwtModule; the seed (Task 6) needs PasswordService.
  exports: [AuthService, PasswordService, JwtModule],
})
export class AuthModule {}
```

- [ ] **Step 9: Register AuthModule**

In `src/app.module.ts`, add `import { AuthModule } from './auth/auth.module.js';` and place `AuthModule` in the `imports` array after `UsersModule`.

- [ ] **Step 10: Run the unit tests to verify they pass**

Run: `npm run test`
Expected: PASS, including all of `auth.service.spec.ts` and the updated `users.service.spec.ts`.

- [ ] **Step 11: Verify registration and login by hand**

```bash
docker compose up -d
npm run start:dev
```

In a second terminal:

```bash
curl -s -X POST localhost:9000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"super-secret","roles":["VOLUNTEER"]}' | head -c 400
```

Expected: a `token` plus a `user` whose `roles` is `["VOLUNTEER","CITIZEN"]`, with no `passwordHash`.

```bash
curl -s -X POST localhost:9000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mallory","email":"m@example.com","password":"super-secret","roles":["ADMIN"]}'
```

Expected: 400 naming `roles`.

```bash
curl -s -X POST localhost:9000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"wrong"}'
```

Expected: 401 `Invalid credentials`. Stop the dev server when done.

- [ ] **Step 12: Commit**

```bash
npm run format && npm run lint
git add src/auth src/users src/app.module.ts .env.example
git commit -m "Add registration and login with JWT issuance"
```

Note: `.env` is gitignored, so only `.env.example` is staged.

---

### Task 4: Guards, decorators and /auth/me

Makes every route default-deny and adds the endpoint that returns authoritative current roles.

**Files:**
- Create: `src/auth/types/request-with-user.ts`
- Create: `src/auth/decorators/public.decorator.ts`
- Create: `src/auth/decorators/roles.decorator.ts`
- Create: `src/auth/decorators/current-user.decorator.ts`
- Create: `src/auth/guards/jwt-auth.guard.ts`
- Create: `src/auth/guards/jwt-auth.guard.spec.ts`
- Create: `src/auth/guards/roles.guard.ts`
- Create: `src/auth/guards/roles.guard.spec.ts`
- Modify: `src/auth/auth.controller.ts`
- Modify: `src/auth/auth.service.ts`
- Modify: `src/app.module.ts`
- Modify: `src/app.controller.ts`, `src/hello/hello.controller.ts`

**Interfaces:**
- Consumes: `JwtPayload`, `AuthenticatedUser` (Task 3); `Role` (Task 1); `JwtService` from the exported `JwtModule` (Task 3).
- Produces: `@Public()`; `@Roles(...roles: Role[])`; `@CurrentUser()` param decorator yielding `AuthenticatedUser`; `JwtAuthGuard`; `RolesGuard`; `AuthService.me(userId: string): Promise<PublicUser>`; `RequestWithUser`.

- [ ] **Step 1: Write the decorators and the request type**

Create `src/auth/types/request-with-user.ts`:

```ts
import { Request } from 'express';
import { AuthenticatedUser } from './jwt-payload.js';

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}
```

Create `src/auth/decorators/public.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of authentication entirely. It short-circuits before any
 * token parsing, so `request.user` is undefined on a public route even when a
 * caller supplies a valid token.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

Create `src/auth/decorators/roles.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';
import { Role } from '../../contracts/index.js';

export const ROLES_KEY = 'roles';

/** The caller must hold at least one of these roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
```

Create `src/auth/decorators/current-user.decorator.ts`:

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from '../types/jwt-payload.js';
import { RequestWithUser } from '../types/request-with-user.js';

/** The authenticated caller, as JwtAuthGuard built it from the token claims. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    return request.user as AuthenticatedUser;
  },
);
```

- [ ] **Step 2: Write the failing RolesGuard test**

Create `src/auth/guards/roles.guard.spec.ts`:

```ts
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../contracts/index.js';
import { AuthenticatedUser } from '../types/jwt-payload.js';
import { RolesGuard } from './roles.guard.js';

const contextFor = (user?: AuthenticatedUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as unknown as ExecutionContext;

const userWith = (...roles: Role[]): AuthenticatedUser => ({
  id: '507f1f77bcf86cd799439011',
  email: 'ada@example.com',
  roles,
});

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  const requireRoles = (roles: Role[] | undefined) =>
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);

  it('allows a route with no @Roles metadata', () => {
    requireRoles(undefined);

    expect(guard.canActivate(contextFor(userWith(Role.CITIZEN)))).toBe(true);
  });

  it('allows a route whose @Roles list is empty', () => {
    requireRoles([]);

    expect(guard.canActivate(contextFor(userWith(Role.CITIZEN)))).toBe(true);
  });

  it('allows a caller holding the single required role', () => {
    requireRoles([Role.AGENCY]);

    expect(guard.canActivate(contextFor(userWith(Role.AGENCY)))).toBe(true);
  });

  it('allows a dual-role caller matching one of two required roles', () => {
    requireRoles([Role.AGENCY, Role.VOLUNTEER]);

    expect(
      guard.canActivate(contextFor(userWith(Role.CITIZEN, Role.VOLUNTEER))),
    ).toBe(true);
  });

  it('denies a caller with no overlapping role', () => {
    requireRoles([Role.ADMIN]);

    expect(guard.canActivate(contextFor(userWith(Role.CITIZEN)))).toBe(false);
  });

  it('denies when there is no authenticated user', () => {
    requireRoles([Role.ADMIN]);

    expect(guard.canActivate(contextFor(undefined))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/auth/guards/roles.guard.spec.ts`
Expected: FAIL — cannot resolve `./roles.guard.js`.

- [ ] **Step 4: Write RolesGuard**

Create `src/auth/guards/roles.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../contracts/index.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { RequestWithUser } from '../types/request-with-user.js';

/**
 * Registered globally after JwtAuthGuard, so `request.user` is already
 * populated. A route without @Roles needs authentication but no specific role.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (!user) {
      return false;
    }

    // Holding ANY of the required roles is enough — a user may hold both
    // CITIZEN and VOLUNTEER, and either should satisfy a guard naming one.
    return required.some((role) => user.roles.includes(role));
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/auth/guards/roles.guard.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Write the failing JwtAuthGuard test**

Create `src/auth/guards/jwt-auth.guard.spec.ts`:

```ts
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '../../contracts/index.js';
import { RequestWithUser } from '../types/request-with-user.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const SECRET = 'test-secret';

const contextFor = (request: Partial<RequestWithUser>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as unknown as ExecutionContext;

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('JwtAuthGuard', () => {
  let jwtService: JwtService;
  let reflector: Reflector;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jwtService = new JwtService({ secret: SECRET });
    reflector = new Reflector();
    guard = new JwtAuthGuard(jwtService, reflector);
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
  });

  it('populates request.user from valid token claims', async () => {
    const token = jwtService.sign({
      sub: '507f1f77bcf86cd799439011',
      email: 'ada@example.com',
      roles: [Role.CITIZEN, Role.VOLUNTEER],
    });
    const request = bearer(token) as Partial<RequestWithUser>;

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toEqual({
      id: '507f1f77bcf86cd799439011',
      email: 'ada@example.com',
      roles: [Role.CITIZEN, Role.VOLUNTEER],
    });
  });

  it('allows a @Public() route with no token at all', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const request = { headers: {} } as Partial<RequestWithUser>;

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    // Public routes short-circuit before parsing, so no user is attached.
    expect(request.user).toBeUndefined();
  });

  it('rejects a request with no Authorization header', async () => {
    await expect(
      guard.canActivate(contextFor({ headers: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a non-Bearer Authorization scheme', async () => {
    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Basic abc' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a malformed token', async () => {
    await expect(
      guard.canActivate(contextFor(bearer('not-a-jwt'))),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = new JwtService({ secret: 'other-secret' }).sign({
      sub: '1',
      email: 'mallory@example.com',
      roles: [Role.ADMIN],
    });

    await expect(guard.canActivate(contextFor(bearer(forged)))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const expired = jwtService.sign(
      { sub: '1', email: 'ada@example.com', roles: [Role.CITIZEN] },
      { expiresIn: '-1s' },
    );

    await expect(
      guard.canActivate(contextFor(bearer(expired))),
    ).rejects.toThrow(UnauthorizedException);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/auth/guards/jwt-auth.guard.spec.ts`
Expected: FAIL — cannot resolve `./jwt-auth.guard.js`.

- [ ] **Step 8: Write JwtAuthGuard**

Create `src/auth/guards/jwt-auth.guard.ts`:

```ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { JwtPayload } from '../types/jwt-payload.js';
import { RequestWithUser } from '../types/request-with-user.js';

/**
 * Registered globally so the default is deny. A route added in a later phase
 * that forgets its guard fails closed with a 401 rather than shipping open.
 *
 * Roles are read from the token claims, so this costs no database round-trip.
 * GET /auth/me exists for clients that need authoritative current roles.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      request.user = {
        id: payload.sub,
        email: payload.email,
        roles: payload.roles ?? [],
      };
    } catch {
      // Expired, malformed and wrongly-signed tokens are all just "no".
      throw new UnauthorizedException();
    }

    return true;
  }

  private extractBearerToken(request: RequestWithUser): string | undefined {
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    return scheme === 'Bearer' ? token : undefined;
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run src/auth/guards/jwt-auth.guard.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 10: Add /auth/me**

In `src/auth/auth.service.ts`, add this method to `AuthService`:

```ts
  /**
   * Re-reads from the database, so the roles returned are authoritative even if
   * the bearer's token was issued before an admin changed them.
   */
  async me(userId: string): Promise<PublicUser> {
    return toPublicUser(await this.usersService.findOne(userId));
  }
```

In `src/auth/auth.controller.ts`, add the imports and the route:

```ts
import { Get } from '@nestjs/common';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import { AuthenticatedUser } from './types/jwt-payload.js';
```

Put `@Public()` on both `register` and `login` (they must stay reachable once the global guard lands), and add:

```ts
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user.id);
  }
```

- [ ] **Step 11: Mark the remaining public routes**

In `src/app.controller.ts`, import `Public` from `./auth/decorators/public.decorator.js` and put `@Public()` on `getHello`.

In `src/hello/hello.controller.ts`, import `Public` from `../auth/decorators/public.decorator.js` and put `@Public()` on the handler.

- [ ] **Step 12: Register both guards globally**

In `src/app.module.ts`, add to the imports at the top:

```ts
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
import { RolesGuard } from './auth/guards/roles.guard.js';
```

and add these two providers **after** the existing `APP_PIPE` and `APP_FILTER` entries:

```ts
    // Order matters: Nest runs global guards in registration order, so
    // JwtAuthGuard populates request.user before RolesGuard reads it.
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
```

`JwtAuthGuard` injects `JwtService`, which `AuthModule` exports via `JwtModule` — make sure `AuthModule` is in `AppModule`'s `imports` (added in Task 3, Step 9).

- [ ] **Step 13: Run the full unit suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 14: Verify the guard end to end**

```bash
docker compose up -d
npm run start:dev
```

In a second terminal:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:9000/auth/me
curl -s -o /dev/null -w '%{http_code}\n' localhost:9000/hello
```

Expected: `401` then `200`.

```bash
TOKEN=$(curl -s -X POST localhost:9000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"super-secret"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

curl -s localhost:9000/auth/me -H "Authorization: Bearer $TOKEN"
```

Expected: the user with `"roles":["VOLUNTEER","CITIZEN"]` and no `passwordHash`. (This uses the account registered in Task 3, Step 11; re-register it if the database was reset.) Stop the dev server when done.

- [ ] **Step 15: Commit**

```bash
npm run format && npm run lint
git add src/auth src/app.module.ts src/app.controller.ts src/hello/hello.controller.ts
git commit -m "Add global JWT and role guards plus GET /auth/me"
```

---

### Task 5: Lock down the users module

Removes the second account-creation path and puts the remaining user administration behind `ADMIN`.

**Files:**
- Modify: `src/users/users.controller.ts`
- Create: `src/users/dto/set-roles.dto.ts`
- Modify: `src/users/users.service.ts`
- Modify: `src/users/users.service.spec.ts`
- Modify: `src/users/users.controller.spec.ts`
- Modify: `test/users.e2e-spec.ts`

**Interfaces:**
- Consumes: `@Roles` (Task 4); `Role`, `PUBLIC_ROLES` (Task 1); `UsersService.setRoles` (Task 3).
- Produces: `PATCH /users/:id/roles`; `SetRolesDto { roles: Role[] }`.

- [ ] **Step 1: Write the failing e2e test**

Replace `test/users.e2e-spec.ts` with the version below. It registers a citizen, promotes them directly in the database, then logs in to obtain an admin token — so it depends on no seed data.

```ts
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { Role } from './../src/contracts/index.js';
import { AppModule } from './../src/app.module.js';

// Exercises the real MongoDB connection, so `docker compose up -d` must be
// running. See README "Running tests".
describe('UsersController (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let adminToken: string;
  let citizenToken: string;

  const PASSWORD = 'super-secret';

  const register = (email: string, roles?: Role[]) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Test User', email, password: PASSWORD, ...(roles ? { roles } : {}) });

  const login = async (email: string): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return body.token;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    connection = moduleFixture.get<Connection>(getConnectionToken());

    // Guard against clobbering a real database if MONGODB_URI is ever
    // misconfigured — vitest.config.e2e.ts is meant to force a "_test" suffix.
    if (!connection.name.endsWith('_test')) {
      throw new Error(
        `Refusing to run destructive e2e tests against database "${connection.name}" ` +
          `— expected a database ending in "_test".`,
      );
    }
  });

  beforeEach(async () => {
    await connection.collection('users').deleteMany({});

    await register('admin@example.com').expect(201);
    await connection
      .collection('users')
      .updateOne({ email: 'admin@example.com' }, { $set: { roles: [Role.ADMIN] } });
    adminToken = await login('admin@example.com');

    await register('citizen@example.com').expect(201);
    citizenToken = await login('citizen@example.com');
  });

  afterAll(async () => {
    await connection.collection('users').deleteMany({});
    await app.close();
  });

  it('no longer exposes POST /users', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Ada', email: 'ada@example.com' })
      .expect(404);
  });

  it('refuses an unauthenticated list', async () => {
    await request(app.getHttpServer()).get('/users').expect(401);
  });

  it('refuses a citizen', async () => {
    await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${citizenToken}`)
      .expect(403);
  });

  it('lists users for an admin', async () => {
    const res = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('updates a user', async () => {
    const { body: list } = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const target = list.find((u: { email: string }) => u.email === 'citizen@example.com');

    const updated = await request(app.getHttpServer())
      .patch(`/users/${target.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Alan Turing' })
      .expect(200);

    expect(updated.body.name).toBe('Alan Turing');
  });

  it('refuses to let PATCH /users/:id escalate roles', async () => {
    const { body: list } = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const target = list.find((u: { email: string }) => u.email === 'citizen@example.com');

    // `roles` is not on UpdateUserDto, and forbidNonWhitelisted rejects it.
    await request(app.getHttpServer())
      .patch(`/users/${target.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: [Role.ADMIN] })
      .expect(400);
  });

  it('grants AGENCY through the dedicated role endpoint', async () => {
    const { body: list } = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const target = list.find((u: { email: string }) => u.email === 'citizen@example.com');

    const granted = await request(app.getHttpServer())
      .patch(`/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: [Role.AGENCY] })
      .expect(200);

    // Replace semantics: AGENCY implies nothing, so CITIZEN is gone.
    expect(granted.body.roles).toEqual([Role.AGENCY]);
  });

  it('applies the VOLUNTEER implication on a role grant', async () => {
    const { body: list } = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const target = list.find((u: { email: string }) => u.email === 'citizen@example.com');

    const granted = await request(app.getHttpServer())
      .patch(`/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: [Role.VOLUNTEER] })
      .expect(200);

    expect(granted.body.roles).toEqual([Role.VOLUNTEER, Role.CITIZEN]);
  });

  it('rejects an empty roles array', async () => {
    const { body: list } = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const target = list.find((u: { email: string }) => u.email === 'citizen@example.com');

    await request(app.getHttpServer())
      .patch(`/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: [] })
      .expect(400);
  });

  it('deletes a user', async () => {
    const { body: list } = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const target = list.find((u: { email: string }) => u.email === 'citizen@example.com');

    await request(app.getHttpServer())
      .delete(`/users/${target.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    await request(app.getHttpServer())
      .get(`/users/${target.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  // Regression: these used to escape as opaque 500s.
  it.each([
    ['get', '/users/not-an-object-id'],
    ['patch', '/users/not-an-object-id'],
    ['delete', '/users/not-an-object-id'],
  ])('returns 400, not 500, for a malformed id (%s)', async (method, url) => {
    const res = await request(app.getHttpServer())
      [method](url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for a well-formed but unknown id', async () => {
    await request(app.getHttpServer())
      .get('/users/000000000000000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose up -d && npm run test:e2e -- test/users.e2e-spec.ts`
Expected: FAIL — `POST /users` still returns 201, and the list returns 200 without a token.

- [ ] **Step 3: Write the SetRolesDto**

Create `src/users/dto/set-roles.dto.ts`:

```ts
import { ArrayNotEmpty, IsArray, IsEnum } from 'class-validator';
import { Role } from '../../contracts/index.js';

export class SetRolesDto {
  // The full enum, not PUBLIC_ROLES: this is the admin-only path by which
  // AGENCY, SPONSOR and ADMIN accounts come into existence.
  // Non-empty because a roleless user could log in and do nothing.
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(Role, { each: true })
  roles: Role[];
}
```

- [ ] **Step 4: Lock down the controller**

Replace `src/users/users.controller.ts` with:

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe.js';
import { Role } from '../contracts/index.js';
import { SetRolesDto } from './dto/set-roles.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UsersService } from './users.service.js';

// User administration. Account creation lives at POST /auth/register — a second
// path here would produce users with no password, unable to log in.
@Controller('users')
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.usersService.update(id, updateUserDto);
  }

  // Separate from PATCH :id on purpose: UpdateUserDto has no `roles`, so the
  // general update route cannot be used to escalate privileges.
  @Patch(':id/roles')
  setRoles(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() setRolesDto: SetRolesDto,
  ) {
    return this.usersService.setRoles(id, setRolesDto.roles);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseObjectIdPipe) id: string) {
    return this.usersService.remove(id);
  }
}
```

`@Roles(Role.ADMIN)` on the class covers every handler — `RolesGuard` reads handler metadata first, then class metadata.

- [ ] **Step 5: Remove the old create path and update the unit specs**

Now that `POST /users` is gone, `UsersService.create` has no caller. In
`src/users/users.service.ts`, delete this method:

```ts
  create(createUserDto: CreateUserDto): Promise<UserDocument> {
    return this.userModel.create(createUserDto);
  }
```

and delete the now-unused `CreateUserDto` import from that file. Keep
`src/users/dto/create-user.dto.ts` itself — `UpdateUserDto` still derives from it.

In `src/users/users.service.spec.ts`, delete the `creates a user` test (it called
the method you just removed) and remove `create` from both the `model` object and
its inline type declaration.

In `src/users/users.controller.spec.ts`, delete the `delegates create to the
service` test, remove `create: vi.fn()` from the `service` mock, add
`setRoles: vi.fn()` to it, and add:

```ts
  it('delegates a role grant to the service', async () => {
    service.setRoles.mockResolvedValue({ roles: [Role.AGENCY] });

    await controller.setRoles('507f1f77bcf86cd799439011', {
      roles: [Role.AGENCY],
    });

    expect(service.setRoles).toHaveBeenCalledWith('507f1f77bcf86cd799439011', [
      Role.AGENCY,
    ]);
  });
```

Import `Role` from `../contracts/index.js`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test && npm run test:e2e -- test/users.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole e2e suite**

Run: `npm run test:e2e`
Expected: PASS. `app.e2e-spec.ts` and `hello.e2e-spec.ts` should still pass unchanged, because Task 4 marked `/` and `/hello` `@Public()`. If either returns 401, the `@Public()` decorator is missing from that controller.

- [ ] **Step 8: Commit**

```bash
npm run format && npm run lint
git add src/users test/users.e2e-spec.ts
git commit -m "Restrict user administration to admins and add role grants"
```

---

### Task 6: Auth e2e coverage, seed and documentation

The end-to-end proof that the Definition of Done holds, plus the demo accounts and the docs that make them usable.

**Files:**
- Create: `test/auth.e2e-spec.ts`
- Modify: `src/seed.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: five seeded demo accounts, one per role.

- [ ] **Step 1: Write the failing auth e2e test**

Create `test/auth.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { Role } from './../src/contracts/index.js';

describe('AuthController (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;

  const PASSWORD = 'super-secret';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    connection = moduleFixture.get<Connection>(getConnectionToken());

    if (!connection.name.endsWith('_test')) {
      throw new Error(
        `Refusing to run destructive e2e tests against database "${connection.name}" ` +
          `— expected a database ending in "_test".`,
      );
    }
  });

  afterEach(async () => {
    await connection.collection('users').deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers, logs in, and reports the caller kind at /auth/me', async () => {
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: PASSWORD,
        roles: [Role.VOLUNTEER],
      })
      .expect(201);

    expect(registered.body.token).toEqual(expect.any(String));
    expect(registered.body.user.roles).toEqual([Role.VOLUNTEER, Role.CITIZEN]);

    const loggedIn = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .expect(200);

    expect(me.body).toMatchObject({
      email: 'ada@example.com',
      roles: [Role.VOLUNTEER, Role.CITIZEN],
      civicPointsCached: 0,
      reputation: 100,
    });
  });

  it('reflects a role change without requiring a new login', async () => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: PASSWORD })
      .expect(201);

    await connection
      .collection('users')
      .updateOne({ email: 'ada@example.com' }, { $set: { roles: [Role.AGENCY] } });

    // The token still carries CITIZEN; /auth/me re-reads and is authoritative.
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.token}`)
      .expect(200);

    expect(me.body.roles).toEqual([Role.AGENCY]);
  });

  it.each([Role.AGENCY, Role.SPONSOR, Role.ADMIN])(
    'refuses to let a registrant grant themselves %s',
    async (role) => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Mallory',
          email: 'mallory@example.com',
          password: PASSWORD,
          roles: [role],
        })
        .expect(400);

      const count = await connection
        .collection('users')
        .countDocuments({ email: 'mallory@example.com' });
      expect(count).toBe(0);
    },
  );

  it('rejects a duplicate email with 409', async () => {
    const payload = { name: 'Ada', email: 'ada@example.com', password: PASSWORD };

    await request(app.getHttpServer())
      .post('/auth/register')
      .send(payload)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...payload, name: 'Ada Again' })
      .expect(409);

    expect(res.body.message).toMatch(/email/);
  });

  it('rejects a password shorter than 8 characters', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'short' })
      .expect(400);
  });

  // Unknown email, wrong password and inactive account must be
  // indistinguishable, so login cannot be used to enumerate accounts.
  it('returns an identical 401 for every login failure mode', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: PASSWORD })
      .expect(201);

    const unknown = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .expect(401);

    const wrongPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: 'not-the-password' })
      .expect(401);

    await connection
      .collection('users')
      .updateOne({ email: 'ada@example.com' }, { $set: { isActive: false } });

    const inactive = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(401);

    expect(unknown.body.message).toBe('Invalid credentials');
    expect(wrongPassword.body.message).toBe(unknown.body.message);
    expect(inactive.body.message).toBe(unknown.body.message);
  });

  it('refuses /auth/me without a token', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('refuses /auth/me with a forged token', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('never returns a password hash in any auth response', async () => {
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: PASSWORD })
      .expect(201);

    const loggedIn = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .expect(200);

    for (const body of [registered.body, loggedIn.body, me.body]) {
      expect(JSON.stringify(body)).not.toContain('passwordHash');
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `docker compose up -d && npm run test:e2e -- test/auth.e2e-spec.ts`
Expected: PASS — Tasks 3 and 4 already implemented this behaviour; this suite is the proof. If anything fails, fix the implementation, not the test.

- [ ] **Step 3: Rewrite the seed with roles and passwords**

Replace `src/seed.ts` with:

```ts
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from './app.module.js';
import { PasswordService } from './auth/password.service.js';
import { Role } from './contracts/index.js';
import { User, UserDocument } from './users/schemas/user.schema.js';

/** Shared by every seeded account. Documented in the README. */
const DEMO_PASSWORD = 'Password123!';

interface SeedUser {
  name: string;
  email: string;
  roles: Role[];
  isActive?: boolean;
}

// One account per actor in the trust chain, so every role can be demonstrated
// without a registration detour.
const SAMPLE_USERS: SeedUser[] = [
  { name: 'Ama Citizen', email: 'citizen@civicon.test', roles: [Role.CITIZEN] },
  {
    name: 'Kofi Volunteer',
    email: 'volunteer@civicon.test',
    roles: [Role.CITIZEN, Role.VOLUNTEER],
  },
  { name: 'Sanitation Officer', email: 'agency@civicon.test', roles: [Role.AGENCY] },
  { name: 'Akwaaba Foundation', email: 'sponsor@civicon.test', roles: [Role.SPONSOR] },
  { name: 'Platform Admin', email: 'admin@civicon.test', roles: [Role.ADMIN] },
  { name: 'Ada Lovelace', email: 'ada@example.com', roles: [Role.CITIZEN] },
  { name: 'Jane Jacobs', email: 'jane@example.com', roles: [Role.CITIZEN], isActive: false },
];

async function seed() {
  // Nest's global logLevels filter also suppresses Logger.log from this
  // script, so the seed reports progress on stdout instead.
  const report = (message: string) => console.log(`[seed] ${message}`);

  // Standalone context: boots the DI container and the Mongoose connection
  // without starting an HTTP listener.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    // Hashed through the real service rather than embedded as literals, so a
    // change of cost factor or algorithm cannot leave stale hashes behind.
    const passwordService = app.get(PasswordService);

    if (process.argv.includes('--fresh')) {
      const { deletedCount } = await userModel.deleteMany({});
      report(`--fresh: removed ${deletedCount} existing user(s)`);
    }

    const passwordHash = await passwordService.hash(DEMO_PASSWORD);

    const result = await userModel.bulkWrite(
      SAMPLE_USERS.map((user) => ({
        updateOne: {
          filter: { email: user.email },
          update: {
            $set: {
              name: user.name,
              roles: user.roles,
              isActive: user.isActive ?? true,
              passwordHash,
            },
          },
          upsert: true,
        },
      })),
    );

    report(
      `inserted: ${result.upsertedCount}, updated: ${result.modifiedCount}`,
    );
    report(`total users in collection: ${await userModel.countDocuments()}`);
    report(`every seeded account uses the password: ${DEMO_PASSWORD}`);
  } finally {
    await app.close();
  }
}

seed().catch((error) => {
  new Logger('Seed').error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 4: Run the seed and verify a seeded account can log in**

```bash
npm run seed -- --fresh
npm run start:dev
```

In a second terminal:

```bash
curl -s -X POST localhost:9000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"agency@civicon.test","password":"Password123!"}' | head -c 300
```

Expected: a token and `"roles":["AGENCY"]`. Stop the dev server when done.

- [ ] **Step 5: Document authentication in the README**

Insert a new section after the existing "Seeding sample data" section:

````markdown
### Demo accounts

`npm run seed` creates one account per actor. They all share the password
`Password123!`.

| Email | Roles |
| --- | --- |
| `citizen@civicon.test` | `CITIZEN` |
| `volunteer@civicon.test` | `CITIZEN`, `VOLUNTEER` |
| `agency@civicon.test` | `AGENCY` |
| `sponsor@civicon.test` | `SPONSOR` |
| `admin@civicon.test` | `ADMIN` |

## Authentication

Every route requires a bearer token unless it is marked `@Public()`. The public
routes are `GET /`, `GET /hello`, `POST /auth/register` and `POST /auth/login`;
everything else returns 401 without a valid token, and 403 when the caller
lacks the role a route requires.

```bash
# sign up — only CITIZEN and VOLUNTEER may be self-assigned
curl -X POST localhost:9000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"super-secret","roles":["VOLUNTEER"]}'

# sign in
curl -X POST localhost:9000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"super-secret"}'

# who am I?
curl localhost:9000/auth/me -H "Authorization: Bearer $TOKEN"
```

Both `register` and `login` return `{ token, user }`. The token's claims carry
the user's roles, so guards need no database round-trip; `GET /auth/me` re-reads
the database and is therefore authoritative when roles have changed since the
token was issued.

`AGENCY`, `SPONSOR` and `ADMIN` cannot be self-assigned — agencies are the
authoritative owners of issues, so that authority is granted by the seed or by
an admin through `PATCH /users/:id/roles`. Granting `VOLUNTEER` also grants
`CITIZEN`: a volunteer is a citizen who also does the work.

`JWT_SECRET` has no default and the app refuses to start without it. Generate
one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**Known gap:** there is no rate limiting on `POST /auth/login`. Adding
`@nestjs/throttler` to that route is the next thing this module needs.
````

- [ ] **Step 6: Run everything**

```bash
npm run format
npm run lint
npm run test
npm run test:e2e
npx tsc --noEmit
```

Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add test/auth.e2e-spec.ts src/seed.ts README.md
git commit -m "Add auth e2e coverage, role-aware seed and auth documentation"
```

---

## Verification against the Definition of Done

Run through the spec's DoD once the six tasks are complete:

- [ ] Each of the five seeded roles can log in and receive a token carrying its roles — Task 6, Step 4, repeated per account.
- [ ] `GET /auth/me` returns authoritative current roles — `auth.e2e-spec.ts`, "reflects a role change without requiring a new login".
- [ ] Registering with `AGENCY`/`SPONSOR`/`ADMIN` is rejected at the API — `auth.e2e-spec.ts`, "refuses to let a registrant grant themselves %s".
- [ ] Unauthenticated → 401, wrong role → 403 — `users.e2e-spec.ts`, "refuses an unauthenticated list" and "refuses a citizen".
- [ ] No response contains `passwordHash` — `auth.e2e-spec.ts`, "never returns a password hash in any auth response", and `users.e2e-spec.ts`, "lists users for an admin".
- [ ] `npm run test`, `npm run test:e2e` and `npm run lint` all pass — Task 6, Step 6.
