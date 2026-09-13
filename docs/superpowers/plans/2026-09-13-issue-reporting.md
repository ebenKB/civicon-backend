# Issue Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a citizen report a civic issue, let anyone read the resulting public record, and let an agency triage it.

**Architecture:** A new `src/issues/` feature module. `IssuesService` owns persistence and queries; a separate `IssueLifecycleService` holds the transition table and is the only place `status` ever changes. Two new enums (`IssueStatus`, `IssueCategory`) join `Role` in `src/contracts/`. Reads are `@Public()`; creating requires `CITIZEN`; status changes require `AGENCY` or `ADMIN`; editing is reporter-only.

**Tech Stack:** NestJS 12 (ESM), Mongoose 9, `class-validator`, `class-transformer`, `@nestjs/mapped-types`, Vitest (unit + e2e), MongoDB 8.

**Spec:** `docs/superpowers/specs/2026-09-13-issue-reporting-design.md`

## Global Constraints

- **ESM codebase.** `package.json` has `"type": "module"` and tsconfig uses `nodenext`. Every relative import MUST carry a `.js` extension, even when importing a `.ts` file: `import { Issue } from './schemas/issue.schema.js';`
- **Node 24, TypeScript 6, `strict: true`, `strictPropertyInitialization: false`** (so Nest's `@Prop()` class fields need no `!`).
- **Global pipe already registered** in `AppModule`: `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`. Any property not declared with a `class-validator` decorator on the DTO produces a 400. Do not register another.
- **Global filter already registered:** `MongoExceptionFilter` maps `CastError` → 400, `ValidationError` → 400, duplicate key (11000) → 409. Do not hand-roll those.
- **Global guards already registered:** `JwtAuthGuard` then `RolesGuard`, as `APP_GUARD`. Every route is default-deny. Use `@Public()` to opt out and `@Roles(...)` to require a role.
- **Query parameters arrive as strings.** `enableImplicitConversion` is NOT set, so numeric query DTO fields need `@Type(() => Number)` from `class-transformer`.
- **No new dependencies.** Everything needed (`class-validator`, `class-transformer`, `@nestjs/mapped-types`) is already installed.
- **Vitest globals are on** (`describe`, `it`, `expect`, `vi` need no import). Unit specs live beside their source as `*.spec.ts`; e2e specs live in `test/` as `*.e2e-spec.ts`.
- **e2e tests need a running database** (`docker compose up -d`) and `JWT_SECRET` in `.env`. The suite refuses to run unless the connected database name ends in `_test`.
- **`status` changes in exactly one place:** `IssueLifecycleService`. `IssuesService` passes no `status` on create — the schema default supplies `OPEN`.
- **No `DELETE` route.** A civic record is not erasable.
- Run `npm run format` and `npm run lint` before each commit.

---

### Task 1: Issue contracts

The two enums every later task imports. `IssueStatus` names the full lifecycle even though this slice implements only the transitions out of `OPEN`, so slice B needs no enum migration.

**Files:**
- Create: `src/contracts/issue-status.ts`
- Create: `src/contracts/issue-category.ts`
- Create: `src/contracts/issue-status.spec.ts`
- Modify: `src/contracts/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `IssueStatus` enum (`OPEN` | `CLAIMED` | `IN_PROGRESS` | `RESOLVED` | `VERIFIED` | `REJECTED` | `DUPLICATE`); `IssueCategory` enum (`SANITATION` | `ROADS` | `WATER` | `ELECTRICITY` | `DRAINAGE` | `PUBLIC_SAFETY` | `OTHER`). Both re-exported from `src/contracts/index.js`.

- [ ] **Step 1: Write the failing test**

Create `src/contracts/issue-status.spec.ts`:

```ts
import { IssueCategory, IssueStatus } from './index.js';

describe('IssueStatus', () => {
  it('names the whole lifecycle, including states slice A cannot reach', () => {
    expect(Object.values(IssueStatus)).toEqual([
      'OPEN',
      'CLAIMED',
      'IN_PROGRESS',
      'RESOLVED',
      'VERIFIED',
      'REJECTED',
      'DUPLICATE',
    ]);
  });

  it('uses identical keys and values, so stored data reads as the enum', () => {
    for (const [key, value] of Object.entries(IssueStatus)) {
      expect(key).toBe(value);
    }
  });
});

describe('IssueCategory', () => {
  it('lists the reportable categories', () => {
    expect(Object.values(IssueCategory)).toEqual([
      'SANITATION',
      'ROADS',
      'WATER',
      'ELECTRICITY',
      'DRAINAGE',
      'PUBLIC_SAFETY',
      'OTHER',
    ]);
  });

  it('uses identical keys and values', () => {
    for (const [key, value] of Object.entries(IssueCategory)) {
      expect(key).toBe(value);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/contracts/issue-status.spec.ts`
Expected: FAIL — `IssueStatus` is not exported from `./index.js`.

- [ ] **Step 3: Write the contracts**

Create `src/contracts/issue-status.ts`:

```ts
/**
 * The full arc an issue travels, declared in one place.
 *
 * CLAIMED, IN_PROGRESS, RESOLVED and VERIFIED are unreachable in the reporting
 * slice: nothing transitions into them yet. They are declared anyway so the
 * claim-and-resolution slice implements transitions rather than widening the
 * contract, and so stored data never needs an enum migration.
 */
export enum IssueStatus {
  OPEN = 'OPEN',
  CLAIMED = 'CLAIMED',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
  DUPLICATE = 'DUPLICATE',
}
```

Create `src/contracts/issue-category.ts`:

```ts
/**
 * What a citizen is reporting. A fixed enum rather than a collection, following
 * the Role precedent — an admin-managed category table is a later slice if it
 * is ever wanted.
 */
export enum IssueCategory {
  SANITATION = 'SANITATION',
  ROADS = 'ROADS',
  WATER = 'WATER',
  ELECTRICITY = 'ELECTRICITY',
  DRAINAGE = 'DRAINAGE',
  PUBLIC_SAFETY = 'PUBLIC_SAFETY',
  OTHER = 'OTHER',
}
```

Replace `src/contracts/index.ts` entirely with:

```ts
export * from './role.js';
export * from './issue-status.js';
export * from './issue-category.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/contracts/issue-status.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint
git add src/contracts
git commit -m "Add IssueStatus and IssueCategory contracts"
```

---

### Task 2: Issue schema and response shaper

The document shape, plus the explicit API projection that keeps a schema field from silently widening responses.

**Files:**
- Create: `src/issues/schemas/issue.schema.ts`
- Create: `src/issues/issue-response.ts`
- Create: `src/issues/issue-response.spec.ts`

**Interfaces:**
- Consumes: `IssueStatus`, `IssueCategory` (Task 1).
- Produces: `Issue` class; `IssueDocument = HydratedDocument<Issue>`; `IssueSchema`; `PublicIssue` interface; `toPublicIssue(issue: IssueDocument): PublicIssue`.

- [ ] **Step 1: Write the failing test**

Create `src/issues/issue-response.spec.ts`:

```ts
import { Types } from 'mongoose';
import { IssueCategory, IssueStatus } from '../contracts/index.js';
import { IssueDocument } from './schemas/issue.schema.js';
import { toPublicIssue } from './issue-response.js';

const reporterId = new Types.ObjectId();
const issueId = new Types.ObjectId();

const issueDoc = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: issueId,
    title: 'Broken streetlight',
    description: 'Dark since Tuesday.',
    category: IssueCategory.ELECTRICITY,
    location: 'Ring Road East, near the bank',
    status: IssueStatus.OPEN,
    reportedBy: reporterId,
    createdAt: new Date('2026-09-13T10:00:00Z'),
    updatedAt: new Date('2026-09-13T10:00:00Z'),
    ...overrides,
  }) as unknown as IssueDocument;

describe('toPublicIssue', () => {
  it('maps the document onto the public shape', () => {
    expect(toPublicIssue(issueDoc())).toEqual({
      id: issueId.toString(),
      title: 'Broken streetlight',
      description: 'Dark since Tuesday.',
      category: IssueCategory.ELECTRICITY,
      location: 'Ring Road East, near the bank',
      status: IssueStatus.OPEN,
      reportedBy: reporterId.toString(),
      statusReason: undefined,
      duplicateOf: undefined,
      createdAt: new Date('2026-09-13T10:00:00Z'),
      updatedAt: new Date('2026-09-13T10:00:00Z'),
    });
  });

  it('renders ids as strings, not ObjectIds', () => {
    const result = toPublicIssue(issueDoc());

    expect(typeof result.id).toBe('string');
    expect(typeof result.reportedBy).toBe('string');
  });

  it('includes the triage fields when they are set', () => {
    const duplicateOf = new Types.ObjectId();
    const result = toPublicIssue(
      issueDoc({
        status: IssueStatus.DUPLICATE,
        statusReason: 'Already reported',
        duplicateOf,
      }),
    );

    expect(result.status).toBe(IssueStatus.DUPLICATE);
    expect(result.statusReason).toBe('Already reported');
    expect(result.duplicateOf).toBe(duplicateOf.toString());
  });

  it('does not leak fields that are not in the public shape', () => {
    const result = toPublicIssue(issueDoc({ internalNote: 'secret' }));

    expect(result).not.toHaveProperty('internalNote');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/issues/issue-response.spec.ts`
Expected: FAIL — cannot resolve `./schemas/issue.schema.js`.

- [ ] **Step 3: Write the schema**

Create `src/issues/schemas/issue.schema.ts`:

```ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { IssueCategory, IssueStatus } from '../../contracts/index.js';

export type IssueDocument = HydratedDocument<Issue>;

@Schema({
  timestamps: true,
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      ret.id = ret._id;
      delete ret._id;
      return ret;
    },
  },
})
export class Issue {
  @Prop({ required: true, trim: true, maxlength: 140 })
  title: string;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  description: string;

  @Prop({ required: true, enum: Object.values(IssueCategory) })
  category: IssueCategory;

  // Free text: a landmark or address. Geospatial coordinates are a later,
  // additive change — see the design doc's Risks table.
  @Prop({ required: true, trim: true, maxlength: 200 })
  location: string;

  // Written by IssueLifecycleService and nowhere else. Creation takes this
  // default rather than passing a value.
  @Prop({
    required: true,
    enum: Object.values(IssueStatus),
    default: IssueStatus.OPEN,
    index: true,
  })
  status: IssueStatus;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  })
  reportedBy: Types.ObjectId;

  @Prop({ trim: true, maxlength: 500 })
  statusReason?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Issue' })
  duplicateOf?: Types.ObjectId;

  // Supplied by `timestamps: true`. Declared without @Prop so they are typed on
  // the document without being redeclared as schema paths.
  createdAt: Date;
  updatedAt: Date;
}

export const IssueSchema = SchemaFactory.createForClass(Issue);

// Serves the default listing: newest first, usually filtered by status.
IssueSchema.index({ status: 1, createdAt: -1 });
```

- [ ] **Step 4: Write the response shaper**

Create `src/issues/issue-response.ts`:

```ts
import { IssueCategory, IssueStatus } from '../contracts/index.js';
import { IssueDocument } from './schemas/issue.schema.js';

/**
 * The issue shape the API returns. Deliberately explicit: adding a field to the
 * schema must not silently widen what the API exposes.
 */
export interface PublicIssue {
  id: string;
  title: string;
  description: string;
  category: IssueCategory;
  location: string;
  status: IssueStatus;
  reportedBy: string;
  statusReason?: string;
  duplicateOf?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicIssue(issue: IssueDocument): PublicIssue {
  return {
    id: issue._id.toString(),
    title: issue.title,
    description: issue.description,
    category: issue.category,
    location: issue.location,
    status: issue.status,
    reportedBy: issue.reportedBy.toString(),
    statusReason: issue.statusReason,
    duplicateOf: issue.duplicateOf?.toString(),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/issues/issue-response.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Add the Issue schema and its public response shape"
```

---

### Task 3: DTOs and IssuesService reads/writes

The persistence layer: create, list with filters and paging, fetch one. No status changes — those are Task 6.

**Files:**
- Create: `src/issues/dto/create-issue.dto.ts`
- Create: `src/issues/dto/update-issue.dto.ts`
- Create: `src/issues/dto/list-issues.query.ts`
- Create: `src/issues/issues.service.ts`
- Create: `src/issues/issues.service.spec.ts`

**Interfaces:**
- Consumes: `Issue`, `IssueDocument` (Task 2); `IssueStatus`, `IssueCategory` (Task 1).
- Produces: `CreateIssueDto { title, description, category, location }`; `UpdateIssueDto` (all optional); `ListIssuesQuery { status?, category?, reportedBy?, limit?, offset? }`; `IssuesService.create(reporterId: string, dto: CreateIssueDto): Promise<IssueDocument>`, `.findAll(query: ListIssuesQuery): Promise<IssueDocument[]>`, `.findOne(id: string): Promise<IssueDocument>`.

- [ ] **Step 1: Write the DTOs**

Create `src/issues/dto/create-issue.dto.ts`:

```ts
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IssueCategory } from '../../contracts/index.js';

/**
 * Four fields, and deliberately no `status` or `reportedBy`. Both are derived
 * by the server — a payload carrying either is rejected as an unknown property
 * by the global forbidNonWhitelisted pipe, so there is no gate to get wrong.
 */
export class CreateIssueDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description: string;

  @IsEnum(IssueCategory)
  category: IssueCategory;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  location: string;
}
```

Create `src/issues/dto/update-issue.dto.ts`:

```ts
import { PartialType } from '@nestjs/mapped-types';
import { CreateIssueDto } from './create-issue.dto.js';

/** Same four editable fields, all optional. Status is not among them. */
export class UpdateIssueDto extends PartialType(CreateIssueDto) {}
```

Create `src/issues/dto/list-issues.query.ts`:

```ts
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { IssueCategory, IssueStatus } from '../../contracts/index.js';

export class ListIssuesQuery {
  @IsOptional()
  @IsEnum(IssueStatus)
  status?: IssueStatus;

  @IsOptional()
  @IsEnum(IssueCategory)
  category?: IssueCategory;

  @IsOptional()
  @IsMongoId()
  reportedBy?: string;

  // Query parameters arrive as strings and enableImplicitConversion is off, so
  // @Type is what makes @IsInt meaningful here.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
```

- [ ] **Step 2: Write the failing service test**

Create `src/issues/issues.service.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { IssueCategory, IssueStatus } from '../contracts/index.js';
import { IssuesService } from './issues.service.js';
import { Issue } from './schemas/issue.schema.js';

const execOf = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

/** Mongoose query builders are chainable, so the list mock returns itself. */
const chainOf = <T>(value: T) => {
  const chain = {
    sort: vi.fn(() => chain),
    skip: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    exec: () => Promise.resolve(value),
  };
  return chain;
};

const REPORTER = '507f1f77bcf86cd799439011';

describe('IssuesService', () => {
  let service: IssuesService;
  let model: {
    create: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    model = { create: vi.fn(), find: vi.fn(), findById: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssuesService,
        { provide: getModelToken(Issue.name), useValue: model },
      ],
    }).compile();

    service = module.get<IssuesService>(IssuesService);
  });

  describe('create', () => {
    const dto = {
      title: 'Blocked drain',
      description: 'Water standing after rain.',
      category: IssueCategory.DRAINAGE,
      location: 'Market Street',
    };

    it('attributes the issue to the caller, not to anything in the body', async () => {
      model.create.mockResolvedValue({});

      await service.create(REPORTER, dto);

      const [input] = model.create.mock.calls[0];
      expect(input.reportedBy.toString()).toBe(REPORTER);
    });

    it('passes no status, leaving the schema default to supply OPEN', async () => {
      model.create.mockResolvedValue({});

      await service.create(REPORTER, dto);

      const [input] = model.create.mock.calls[0];
      expect(input).not.toHaveProperty('status');
    });
  });

  describe('findAll', () => {
    it('applies no filter when the query is empty', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({});

      expect(model.find).toHaveBeenCalledWith({});
    });

    it('filters by status and category', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({
        status: IssueStatus.OPEN,
        category: IssueCategory.ROADS,
      });

      expect(model.find).toHaveBeenCalledWith({
        status: IssueStatus.OPEN,
        category: IssueCategory.ROADS,
      });
    });

    it('filters by reporter as an ObjectId, not a string', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({ reportedBy: REPORTER });

      const [filter] = model.find.mock.calls[0];
      expect(filter.reportedBy).toBeInstanceOf(Types.ObjectId);
      expect(filter.reportedBy.toString()).toBe(REPORTER);
    });

    it('sorts newest first and applies the default paging window', async () => {
      const chain = chainOf([]);
      model.find.mockReturnValue(chain);

      await service.findAll({});

      expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(chain.skip).toHaveBeenCalledWith(0);
      expect(chain.limit).toHaveBeenCalledWith(20);
    });

    it('honours an explicit limit and offset', async () => {
      const chain = chainOf([]);
      model.find.mockReturnValue(chain);

      await service.findAll({ limit: 5, offset: 10 });

      expect(chain.skip).toHaveBeenCalledWith(10);
      expect(chain.limit).toHaveBeenCalledWith(5);
    });
  });

  describe('findOne', () => {
    it('returns the issue when it exists', async () => {
      model.findById.mockReturnValue(execOf({ title: 'Blocked drain' }));

      await expect(service.findOne('anything')).resolves.toMatchObject({
        title: 'Blocked drain',
      });
    });

    it('throws NotFoundException when it does not', async () => {
      model.findById.mockReturnValue(execOf(null));

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/issues/issues.service.spec.ts`
Expected: FAIL — cannot resolve `./issues.service.js`.

- [ ] **Step 4: Write the service**

Create `src/issues/issues.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { ListIssuesQuery } from './dto/list-issues.query.js';
import { Issue, IssueDocument } from './schemas/issue.schema.js';

const DEFAULT_LIMIT = 20;

/**
 * Persistence and queries for issues. This service never changes `status` —
 * that belongs to IssueLifecycleService, which is the single write path for it.
 */
@Injectable()
export class IssuesService {
  constructor(
    @InjectModel(Issue.name) private readonly issueModel: Model<IssueDocument>,
  ) {}

  create(reporterId: string, dto: CreateIssueDto): Promise<IssueDocument> {
    // reportedBy comes from the authenticated caller; no status is passed, so
    // the schema default (OPEN) applies.
    return this.issueModel.create({
      ...dto,
      reportedBy: new Types.ObjectId(reporterId),
    });
  }

  findAll(query: ListIssuesQuery): Promise<IssueDocument[]> {
    const filter: FilterQuery<IssueDocument> = {};
    if (query.status) {
      filter.status = query.status;
    }
    if (query.category) {
      filter.category = query.category;
    }
    if (query.reportedBy) {
      filter.reportedBy = new Types.ObjectId(query.reportedBy);
    }

    return this.issueModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(query.offset ?? 0)
      .limit(query.limit ?? DEFAULT_LIMIT)
      .exec();
  }

  async findOne(id: string): Promise<IssueDocument> {
    const issue = await this.issueModel.findById(id).exec();
    if (!issue) {
      throw new NotFoundException(`Issue with id "${id}" not found`);
    }
    return issue;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/issues/issues.service.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Add issue DTOs and the IssuesService read/write paths"
```

---

### Task 4: Controller, module and wiring

The first runnable deliverable: report an issue, list issues, read one.

**Files:**
- Create: `src/issues/issues.controller.ts`
- Create: `src/issues/issues.module.ts`
- Create: `src/issues/issues.controller.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `IssuesService` (Task 3); `toPublicIssue` (Task 2); `@Public()`, `@Roles()`, `@CurrentUser()`, `AuthenticatedUser` (existing auth slice); `ParseObjectIdPipe` (existing).
- Produces: `IssuesController` with `POST /issues`, `GET /issues`, `GET /issues/:id`; `IssuesModule` (exports `IssuesService`).

- [ ] **Step 1: Write the failing controller test**

Create `src/issues/issues.controller.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { IssueCategory, IssueStatus } from '../contracts/index.js';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';

const reporterId = new Types.ObjectId();

const issueDoc = () =>
  ({
    _id: new Types.ObjectId(),
    title: 'Blocked drain',
    description: 'Water standing after rain.',
    category: IssueCategory.DRAINAGE,
    location: 'Market Street',
    status: IssueStatus.OPEN,
    reportedBy: reporterId,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as never;

const caller = {
  id: reporterId.toString(),
  email: 'citizen@civicon.test',
  roles: [],
} as never;

describe('IssuesController', () => {
  let controller: IssuesController;
  let service: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findAll: vi.fn(),
      findOne: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [IssuesController],
      providers: [{ provide: IssuesService, useValue: service }],
    }).compile();

    controller = module.get<IssuesController>(IssuesController);
  });

  it('passes the caller id to create, not anything from the body', async () => {
    service.create.mockResolvedValue(issueDoc());
    const dto = {
      title: 'Blocked drain',
      description: 'Water standing after rain.',
      category: IssueCategory.DRAINAGE,
      location: 'Market Street',
    };

    await controller.create(caller, dto);

    expect(service.create).toHaveBeenCalledWith(reporterId.toString(), dto);
  });

  it('returns the public shape from create', async () => {
    service.create.mockResolvedValue(issueDoc());

    const result = await controller.create(caller, {
      title: 'Blocked drain',
      description: 'Water standing after rain.',
      category: IssueCategory.DRAINAGE,
      location: 'Market Street',
    });

    expect(result.status).toBe(IssueStatus.OPEN);
    expect(typeof result.reportedBy).toBe('string');
  });

  it('maps every issue in a listing to the public shape', async () => {
    service.findAll.mockResolvedValue([issueDoc(), issueDoc()]);

    const result = await controller.findAll({});

    expect(result).toHaveLength(2);
    expect(typeof result[0].id).toBe('string');
  });

  it('delegates findOne to the service', async () => {
    service.findOne.mockResolvedValue(issueDoc());

    await controller.findOne('507f1f77bcf86cd799439011');

    expect(service.findOne).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/issues/issues.controller.spec.ts`
Expected: FAIL — cannot resolve `./issues.controller.js`.

- [ ] **Step 3: Write the controller**

Create `src/issues/issues.controller.ts`:

```ts
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AuthenticatedUser } from '../auth/types/jwt-payload.js';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe.js';
import { Role } from '../contracts/index.js';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { ListIssuesQuery } from './dto/list-issues.query.js';
import { toPublicIssue } from './issue-response.js';
import { IssuesService } from './issues.service.js';

@Controller('issues')
export class IssuesController {
  constructor(private readonly issuesService: IssuesService) {}

  @Post()
  @Roles(Role.CITIZEN)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createIssueDto: CreateIssueDto,
  ) {
    return toPublicIssue(await this.issuesService.create(user.id, createIssueDto));
  }

  // The civic record is readable without an account: a transparency platform
  // that requires a login is not one.
  @Public()
  @Get()
  async findAll(@Query() query: ListIssuesQuery) {
    const issues = await this.issuesService.findAll(query);
    return issues.map(toPublicIssue);
  }

  @Public()
  @Get(':id')
  async findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return toPublicIssue(await this.issuesService.findOne(id));
  }
}
```

- [ ] **Step 4: Write the module**

Create `src/issues/issues.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';
import { Issue, IssueSchema } from './schemas/issue.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Issue.name, schema: IssueSchema }]),
  ],
  controllers: [IssuesController],
  providers: [IssuesService],
  // Exported so later slices (claiming, points) can inject it.
  exports: [IssuesService],
})
export class IssuesModule {}
```

- [ ] **Step 5: Register the module**

In `src/app.module.ts`, add the import:

```ts
import { IssuesModule } from './issues/issues.module.js';
```

and add `IssuesModule` to the `imports` array, after `AuthModule`.

- [ ] **Step 6: Run the unit suite**

Run: `npm run test`
Expected: PASS, including the four new controller tests.

- [ ] **Step 7: Verify by hand**

```bash
docker compose up -d
npm run build && npm run start:dev
```

In a second terminal:

```bash
# Public read needs no token
curl -s -o /dev/null -w 'GET /issues -> %{http_code}\n' localhost:9000/issues

# Creating without a token is refused
curl -s -o /dev/null -w 'anon POST -> %{http_code}\n' -X POST localhost:9000/issues \
  -H 'Content-Type: application/json' \
  -d '{"title":"Blocked drain","description":"Standing water.","category":"DRAINAGE","location":"Market Street"}'

TOKEN=$(curl -s -X POST localhost:9000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"citizen@civicon.test","password":"Password123!"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

curl -s -X POST localhost:9000/issues -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Blocked drain","description":"Standing water.","category":"DRAINAGE","location":"Market Street"}'
```

Expected: `200`, then `401`, then a 201 body with `"status":"OPEN"` and a `reportedBy` matching the citizen. (Run `npm run seed` first if the seeded accounts are missing.)

Then confirm the body cannot dictate ownership or status:

```bash
curl -s -X POST localhost:9000/issues -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"X","description":"Y","category":"ROADS","location":"Z","status":"VERIFIED"}'
```

Expected: 400 naming `status`. Stop the dev server when done.

- [ ] **Step 8: Commit**

```bash
npm run format && npm run lint
git add src/issues src/app.module.ts
git commit -m "Add issue reporting endpoints with public read"
```

---

### Task 5: Reporter-only editing

A reporter may correct their own issue while it is still `OPEN`. Nobody else may, including an admin.

**Files:**
- Modify: `src/issues/issues.service.ts`
- Modify: `src/issues/issues.service.spec.ts`
- Modify: `src/issues/issues.controller.ts`
- Modify: `src/issues/issues.controller.spec.ts`

**Interfaces:**
- Consumes: `UpdateIssueDto` (Task 3); `IssuesService.findOne` (Task 3).
- Produces: `IssuesService.updateOwn(id: string, actorId: string, dto: UpdateIssueDto): Promise<IssueDocument>`; `PATCH /issues/:id`.

- [ ] **Step 1: Write the failing service test**

Append to the `describe('IssuesService', ...)` block in `src/issues/issues.service.spec.ts`. Add `ConflictException` and `ForbiddenException` to the `@nestjs/common` import at the top of the file:

```ts
  describe('updateOwn', () => {
    const ownedIssue = () => ({
      reportedBy: new Types.ObjectId(REPORTER),
      status: IssueStatus.OPEN,
      title: 'Blocked drain',
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('applies the changes when the caller is the reporter', async () => {
      const issue = ownedIssue();
      model.findById.mockReturnValue(execOf(issue));

      const result = await service.updateOwn(REPORTER, REPORTER, {
        title: 'Blocked drain on Market Street',
      });

      expect(result.title).toBe('Blocked drain on Market Street');
      expect(issue.save).toHaveBeenCalled();
    });

    it('refuses a caller who is not the reporter', async () => {
      model.findById.mockReturnValue(execOf(ownedIssue()));

      await expect(
        service.updateOwn(REPORTER, '507f1f77bcf86cd799439099', {
          title: 'Hijacked',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses once the issue has left OPEN', async () => {
      const issue = ownedIssue();
      issue.status = IssueStatus.REJECTED;
      model.findById.mockReturnValue(execOf(issue));

      await expect(
        service.updateOwn(REPORTER, REPORTER, { title: 'Too late' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('never lets an update change the status', async () => {
      const issue = ownedIssue();
      model.findById.mockReturnValue(execOf(issue));

      await service.updateOwn(REPORTER, REPORTER, {
        title: 'Still open',
      } as never);

      expect(issue.status).toBe(IssueStatus.OPEN);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/issues/issues.service.spec.ts`
Expected: FAIL — `service.updateOwn is not a function`.

- [ ] **Step 3: Implement updateOwn**

In `src/issues/issues.service.ts`, widen the `@nestjs/common` import to
`import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';`,
add `import { UpdateIssueDto } from './dto/update-issue.dto.js';`, and add this
method after `findOne`:

```ts
  /**
   * Ownership, not role, is the requirement — an admin editing someone else's
   * issue gets the same 403. Rewriting a citizen's account of what they saw is
   * not an administrative power; REJECTED is the recorded alternative.
   */
  async updateOwn(
    id: string,
    actorId: string,
    dto: UpdateIssueDto,
  ): Promise<IssueDocument> {
    const issue = await this.findOne(id);

    if (issue.reportedBy.toString() !== actorId) {
      throw new ForbiddenException('You can only edit issues you reported');
    }

    // An agency may already have acted on what it read.
    if (issue.status !== IssueStatus.OPEN) {
      throw new ConflictException(
        `An issue can only be edited while OPEN; this one is ${issue.status}`,
      );
    }

    Object.assign(issue, dto);
    return issue.save();
  }
```

Add `import { IssueStatus } from '../contracts/index.js';` to the file's imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/issues/issues.service.spec.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Add the route**

In `src/issues/issues.controller.ts`, add `Patch` to the `@nestjs/common` import,
add `import { UpdateIssueDto } from './dto/update-issue.dto.js';`, and add:

```ts
  // Authenticated but no @Roles(): ownership is the requirement, and the
  // service enforces it.
  @Patch(':id')
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() updateIssueDto: UpdateIssueDto,
  ) {
    return toPublicIssue(
      await this.issuesService.updateOwn(id, user.id, updateIssueDto),
    );
  }
```

In `src/issues/issues.controller.spec.ts`, add `updateOwn: vi.fn()` to the
`service` object and add this test:

```ts
  it('passes the caller id to updateOwn so ownership can be checked', async () => {
    service.updateOwn.mockResolvedValue(issueDoc());

    await controller.update('507f1f77bcf86cd799439011', caller, {
      title: 'Corrected',
    });

    expect(service.updateOwn).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      reporterId.toString(),
      { title: 'Corrected' },
    );
  });
```

- [ ] **Step 6: Run the unit suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Allow a reporter to edit their own open issue"
```

---

### Task 6: IssueLifecycleService and the status route

The transition table, and the only place `status` ever changes.

**Files:**
- Create: `src/issues/dto/change-status.dto.ts`
- Create: `src/issues/issue-lifecycle.service.ts`
- Create: `src/issues/issue-lifecycle.service.spec.ts`
- Modify: `src/issues/issues.controller.ts`
- Modify: `src/issues/issues.controller.spec.ts`
- Modify: `src/issues/issues.module.ts`

**Interfaces:**
- Consumes: `IssuesService.findOne` (Task 3); `IssueStatus` (Task 1).
- Produces: `ChangeStatusDto { status: IssueStatus; reason?: string; duplicateOf?: string }`; `IssueLifecycleService.changeStatus(id: string, dto: ChangeStatusDto): Promise<IssueDocument>`; `PATCH /issues/:id/status`.

- [ ] **Step 1: Write the DTO**

Create `src/issues/dto/change-status.dto.ts`:

```ts
import { IsEnum, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { IssueStatus } from '../../contracts/index.js';

/**
 * `reason` and `duplicateOf` are conditionally required, and that condition is
 * enforced in IssueLifecycleService rather than here: which one is needed
 * depends on the target status, and duplicateOf additionally needs a database
 * read to confirm the referenced issue exists.
 */
export class ChangeStatusDto {
  @IsEnum(IssueStatus)
  status: IssueStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsMongoId()
  duplicateOf?: string;
}
```

- [ ] **Step 2: Write the failing lifecycle test**

Create `src/issues/issue-lifecycle.service.spec.ts`:

```ts
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { IssueStatus } from '../contracts/index.js';
import { IssueLifecycleService } from './issue-lifecycle.service.js';
import { IssuesService } from './issues.service.js';

const ISSUE_ID = '507f1f77bcf86cd799439011';
const OTHER_ID = '507f1f77bcf86cd799439022';

describe('IssueLifecycleService', () => {
  let service: IssueLifecycleService;
  let issuesService: { findOne: ReturnType<typeof vi.fn> };

  const issueAt = (status: IssueStatus) => ({
    status,
    save: vi.fn().mockImplementation(function (this: unknown) {
      return Promise.resolve(this);
    }),
  });

  beforeEach(async () => {
    issuesService = { findOne: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssueLifecycleService,
        { provide: IssuesService, useValue: issuesService },
      ],
    }).compile();

    service = module.get<IssueLifecycleService>(IssueLifecycleService);
  });

  describe('allowed transitions', () => {
    it('rejects an OPEN issue when a reason is given', async () => {
      const issue = issueAt(IssueStatus.OPEN);
      issuesService.findOne.mockResolvedValue(issue);

      const result = await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.REJECTED,
        reason: 'Not a municipal responsibility',
      });

      expect(result.status).toBe(IssueStatus.REJECTED);
      expect(result.statusReason).toBe('Not a municipal responsibility');
      expect(issue.save).toHaveBeenCalled();
    });

    it('marks an OPEN issue a duplicate of an existing issue', async () => {
      const issue = issueAt(IssueStatus.OPEN);
      issuesService.findOne
        .mockResolvedValueOnce(issue)
        .mockResolvedValueOnce(issueAt(IssueStatus.OPEN));

      const result = await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.DUPLICATE,
        duplicateOf: OTHER_ID,
      });

      expect(result.status).toBe(IssueStatus.DUPLICATE);
      expect(result.duplicateOf?.toString()).toBe(OTHER_ID);
    });
  });

  describe('refused transitions', () => {
    it.each([
      IssueStatus.CLAIMED,
      IssueStatus.IN_PROGRESS,
      IssueStatus.RESOLVED,
      IssueStatus.VERIFIED,
    ])('refuses OPEN -> %s, which belongs to a later slice', async (target) => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: target }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses any move out of a terminal state', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.REJECTED));

      await expect(
        service.changeStatus(ISSUE_ID, {
          status: IssueStatus.OPEN,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a transition to the current status rather than treating it as a no-op', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.OPEN }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('names both states in the refusal', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.VERIFIED }),
      ).rejects.toThrow(/OPEN.*VERIFIED/);
    });
  });

  describe('required companions', () => {
    it('requires a reason when rejecting', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.REJECTED }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires duplicateOf when marking a duplicate', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.DUPLICATE }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an issue that is a duplicate of itself', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, {
          status: IssueStatus.DUPLICATE,
          duplicateOf: ISSUE_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('propagates the 404 when duplicateOf names an unknown issue', async () => {
      issuesService.findOne
        .mockResolvedValueOnce(issueAt(IssueStatus.OPEN))
        .mockRejectedValueOnce(new Error('Issue with id not found'));

      await expect(
        service.changeStatus(ISSUE_ID, {
          status: IssueStatus.DUPLICATE,
          duplicateOf: OTHER_ID,
        }),
      ).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/issues/issue-lifecycle.service.spec.ts`
Expected: FAIL — cannot resolve `./issue-lifecycle.service.js`.

- [ ] **Step 4: Write the lifecycle service**

Create `src/issues/issue-lifecycle.service.ts`:

```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { IssueStatus } from '../contracts/index.js';
import { ChangeStatusDto } from './dto/change-status.dto.js';
import { IssuesService } from './issues.service.js';
import { IssueDocument } from './schemas/issue.schema.js';

/**
 * The transition table. Only moves out of OPEN exist in the reporting slice;
 * claiming and resolution add the rest without touching anything else here.
 */
const ALLOWED_TRANSITIONS: ReadonlyMap<IssueStatus, readonly IssueStatus[]> =
  new Map([
    [IssueStatus.OPEN, [IssueStatus.REJECTED, IssueStatus.DUPLICATE]],
  ]);

/**
 * The single place an issue's status changes. Keeping it out of IssuesService
 * means the rules are unit-testable without a database, and the later slices'
 * lock and anti-self-dealing checks have an obvious home.
 */
@Injectable()
export class IssueLifecycleService {
  constructor(private readonly issuesService: IssuesService) {}

  async changeStatus(
    id: string,
    dto: ChangeStatusDto,
  ): Promise<IssueDocument> {
    const issue = await this.issuesService.findOne(id);

    const allowed = ALLOWED_TRANSITIONS.get(issue.status) ?? [];
    // A move to the current status is refused rather than ignored: silently
    // accepting it would hide a client bug.
    if (!allowed.includes(dto.status)) {
      throw new ConflictException(
        `Cannot move an issue from ${issue.status} to ${dto.status}`,
      );
    }

    if (dto.status === IssueStatus.REJECTED && !dto.reason) {
      throw new BadRequestException(
        'A reason is required when rejecting an issue',
      );
    }

    if (dto.status === IssueStatus.DUPLICATE) {
      if (!dto.duplicateOf) {
        throw new BadRequestException(
          'duplicateOf is required when marking an issue a duplicate',
        );
      }
      if (dto.duplicateOf === id) {
        throw new BadRequestException('An issue cannot duplicate itself');
      }
      // Throws NotFoundException if the referenced issue does not exist.
      await this.issuesService.findOne(dto.duplicateOf);
      issue.duplicateOf = new Types.ObjectId(dto.duplicateOf);
    }

    issue.status = dto.status;
    issue.statusReason = dto.reason;
    return issue.save();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/issues/issue-lifecycle.service.spec.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Add the route and register the provider**

In `src/issues/issues.module.ts`, add
`import { IssueLifecycleService } from './issue-lifecycle.service.js';` and put
`IssueLifecycleService` in both `providers` and `exports`, beside `IssuesService`.

In `src/issues/issues.controller.ts`, add
`import { ChangeStatusDto } from './dto/change-status.dto.js';` and
`import { IssueLifecycleService } from './issue-lifecycle.service.js';`, widen
the constructor to:

```ts
  constructor(
    private readonly issuesService: IssuesService,
    private readonly issueLifecycleService: IssueLifecycleService,
  ) {}
```

and add the route:

```ts
  // Agencies remain the authoritative owners of an issue's state.
  @Patch(':id/status')
  @Roles(Role.AGENCY, Role.ADMIN)
  async changeStatus(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() changeStatusDto: ChangeStatusDto,
  ) {
    return toPublicIssue(
      await this.issueLifecycleService.changeStatus(id, changeStatusDto),
    );
  }
```

In `src/issues/issues.controller.spec.ts`, add the lifecycle provider to the
testing module and a delegation test. Add
`import { IssueLifecycleService } from './issue-lifecycle.service.js';` at the
top, declare `let lifecycle: Record<string, ReturnType<typeof vi.fn>>;`, and
inside `beforeEach` set `lifecycle = { changeStatus: vi.fn() };` and extend
`providers`:

```ts
      providers: [
        { provide: IssuesService, useValue: service },
        { provide: IssueLifecycleService, useValue: lifecycle },
      ],
```

Then add:

```ts
  it('routes a status change through the lifecycle service', async () => {
    lifecycle.changeStatus.mockResolvedValue(issueDoc());

    await controller.changeStatus('507f1f77bcf86cd799439011', {
      status: IssueStatus.REJECTED,
      reason: 'Out of scope',
    });

    expect(lifecycle.changeStatus).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      { status: IssueStatus.REJECTED, reason: 'Out of scope' },
    );
  });
```

- [ ] **Step 7: Run the unit suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Add IssueLifecycleService and the agency status route"
```

---

### Task 7: End-to-end coverage

Proves the guard stack, the ownership rule and the transition refusals against a real database.

**Files:**
- Create: `test/issues.e2e-spec.ts`

**Interfaces:**
- Consumes: every route from Tasks 4-6; the auth slice's `/auth/register` and `/auth/login`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the e2e suite**

Create `test/issues.e2e-spec.ts`. It builds its own actors rather than relying
on the seed, so it passes on an empty database:

```ts
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { IssueCategory, IssueStatus, Role } from './../src/contracts/index.js';

const PASSWORD = 'super-secret';

const ISSUE = {
  title: 'Blocked drain',
  description: 'Standing water after every rain.',
  category: IssueCategory.DRAINAGE,
  location: 'Market Street, by the junction',
};

describe('IssuesController (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let citizenToken: string;
  let otherCitizenToken: string;
  let agencyToken: string;

  const register = (email: string) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Test User', email, password: PASSWORD });

  const login = async (email: string): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return body.token;
  };

  const createIssue = (token: string) =>
    request(app.getHttpServer())
      .post('/issues')
      .set('Authorization', `Bearer ${token}`)
      .send(ISSUE);

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

  beforeEach(async () => {
    await connection.collection('issues').deleteMany({});
    await connection.collection('users').deleteMany({});

    await register('citizen@example.com').expect(201);
    await register('other@example.com').expect(201);
    await register('agency@example.com').expect(201);

    // Registration always creates a CITIZEN; promote one directly, since
    // granting AGENCY through the API would itself need an admin.
    await connection
      .collection('users')
      .updateOne(
        { email: 'agency@example.com' },
        { $set: { roles: [Role.AGENCY] } },
      );

    citizenToken = await login('citizen@example.com');
    otherCitizenToken = await login('other@example.com');
    agencyToken = await login('agency@example.com');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('reading', () => {
    it('lists issues without a token', async () => {
      await createIssue(citizenToken).expect(201);

      const res = await request(app.getHttpServer()).get('/issues').expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].title).toBe(ISSUE.title);
    });

    it('reads one issue without a token', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/issues/${body.id}`)
        .expect(200);

      expect(res.body.id).toBe(body.id);
    });

    it('returns 404 for an unknown issue', async () => {
      await request(app.getHttpServer())
        .get('/issues/000000000000000000000000')
        .expect(404);
    });

    it('returns 400 for a malformed id', async () => {
      await request(app.getHttpServer()).get('/issues/nonsense').expect(400);
    });

    it('filters by status', async () => {
      await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .get(`/issues?status=${IssueStatus.OPEN}`)
        .expect(200)
        .expect((res) => expect(res.body).toHaveLength(1));

      await request(app.getHttpServer())
        .get(`/issues?status=${IssueStatus.VERIFIED}`)
        .expect(200)
        .expect((res) => expect(res.body).toHaveLength(0));
    });

    it('rejects an unknown status filter', async () => {
      await request(app.getHttpServer())
        .get('/issues?status=NONSENSE')
        .expect(400);
    });

    it('applies limit', async () => {
      await createIssue(citizenToken).expect(201);
      await createIssue(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get('/issues?limit=1')
        .expect(200);

      expect(res.body).toHaveLength(1);
    });
  });

  describe('creating', () => {
    it('attributes the issue to the caller and opens it', async () => {
      const res = await createIssue(citizenToken).expect(201);

      expect(res.body.status).toBe(IssueStatus.OPEN);
      expect(res.body.reportedBy).toEqual(expect.any(String));
      expect(res.body.id).toEqual(expect.any(String));
    });

    it('refuses an anonymous create', async () => {
      await request(app.getHttpServer()).post('/issues').send(ISSUE).expect(401);
    });

    it('refuses a create from a non-citizen role', async () => {
      await request(app.getHttpServer())
        .post('/issues')
        .set('Authorization', `Bearer ${agencyToken}`)
        .send(ISSUE)
        .expect(403);
    });

    it.each(['status', 'reportedBy'])(
      'refuses a body carrying %s',
      async (field) => {
        await request(app.getHttpServer())
          .post('/issues')
          .set('Authorization', `Bearer ${citizenToken}`)
          .send({ ...ISSUE, [field]: 'VERIFIED' })
          .expect(400);
      },
    );

    it('refuses an unknown category', async () => {
      await request(app.getHttpServer())
        .post('/issues')
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ ...ISSUE, category: 'NONSENSE' })
        .expect(400);
    });
  });

  describe('editing', () => {
    it('lets the reporter correct their own open issue', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/issues/${body.id}`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ title: 'Blocked drain by the junction' })
        .expect(200);

      expect(res.body.title).toBe('Blocked drain by the junction');
    });

    it('refuses a different citizen', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}`)
        .set('Authorization', `Bearer ${otherCitizenToken}`)
        .send({ title: 'Hijacked' })
        .expect(403);
    });

    it('refuses editing an issue that has left OPEN', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.REJECTED, reason: 'Out of scope' })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ title: 'Too late' })
        .expect(409);
    });
  });

  describe('triage', () => {
    it('lets an agency reject an issue with a reason', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.REJECTED, reason: 'Private land' })
        .expect(200);

      expect(res.body.status).toBe(IssueStatus.REJECTED);
      expect(res.body.statusReason).toBe('Private land');
    });

    it('refuses a status change from a citizen', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ status: IssueStatus.REJECTED, reason: 'Mine now' })
        .expect(403);
    });

    it('refuses a transition that belongs to a later slice', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.VERIFIED })
        .expect(409);
    });

    it('requires a reason when rejecting', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.REJECTED })
        .expect(400);
    });

    it('marks an issue a duplicate of another', async () => {
      const { body: original } = await createIssue(citizenToken).expect(201);
      const { body: copy } = await createIssue(otherCitizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/issues/${copy.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.DUPLICATE, duplicateOf: original.id })
        .expect(200);

      expect(res.body.status).toBe(IssueStatus.DUPLICATE);
      expect(res.body.duplicateOf).toBe(original.id);
    });

    it('refuses an issue that duplicates itself', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.DUPLICATE, duplicateOf: body.id })
        .expect(400);
    });
  });
});
```

- [ ] **Step 2: Run the e2e suite**

```bash
docker compose up -d
npm run test:e2e
```

Expected: PASS, all suites. If `beforeEach` times out, confirm
`vitest.config.e2e.ts` still carries the raised `hookTimeout` — each hook
registers and logs in three accounts, which is six bcrypt operations at cost 12.

- [ ] **Step 3: Commit**

```bash
npm run format && npm run lint
git add test/issues.e2e-spec.ts
git commit -m "Add issue reporting e2e coverage"
```

---

### Task 8: Seed data and documentation

Gives the demo something to show, and records the new endpoints.

**Files:**
- Modify: `src/seed.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `Issue`, `IssueDocument` (Task 2); `IssueCategory` (Task 1); the existing seeded users.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Extend the seed**

In `src/seed.ts`, add these imports:

```ts
import { IssueCategory } from './contracts/index.js';
import { Issue, IssueDocument } from './issues/schemas/issue.schema.js';
```

Add the sample data below the existing `SAMPLE_USERS` constant:

```ts
interface SeedIssue {
  title: string;
  description: string;
  category: IssueCategory;
  location: string;
  /** Email of the seeded user who reported it. */
  reporterEmail: string;
}

// All OPEN, so the claim-and-resolution slice has material to work with.
const SAMPLE_ISSUES: SeedIssue[] = [
  {
    title: 'Blocked drain floods the junction',
    description: 'Standing water after every rain; the gutter is full of silt.',
    category: IssueCategory.DRAINAGE,
    location: 'Market Street junction',
    reporterEmail: 'citizen@civicon.test',
  },
  {
    title: 'Streetlight out for two weeks',
    description: 'The stretch by the school is dark from dusk.',
    category: IssueCategory.ELECTRICITY,
    location: 'Ring Road East, by the school',
    reporterEmail: 'citizen@civicon.test',
  },
  {
    title: 'Pothole damaging vehicles',
    description: 'Deep pothole in the inbound lane, widening each week.',
    category: IssueCategory.ROADS,
    location: 'Independence Avenue, inbound',
    reporterEmail: 'volunteer@civicon.test',
  },
  {
    title: 'Refuse skip overflowing',
    description: 'Uncollected for ten days; waste is spreading onto the path.',
    category: IssueCategory.SANITATION,
    location: 'Behind the central market',
    reporterEmail: 'ada@example.com',
  },
];
```

Inside `seed()`, after the user `bulkWrite` and before the final `report` calls,
add:

```ts
    const issueModel = app.get<Model<IssueDocument>>(getModelToken(Issue.name));

    if (process.argv.includes('--fresh')) {
      const { deletedCount } = await issueModel.deleteMany({});
      report(`--fresh: removed ${deletedCount} existing issue(s)`);
    }

    // Reporter emails resolve to ids here rather than being hard-coded, so the
    // seed stays correct however the user documents were created.
    const usersByEmail = new Map(
      (await userModel.find().select('_id email').exec()).map((user) => [
        user.email,
        user._id,
      ]),
    );

    const issueResult = await issueModel.bulkWrite(
      SAMPLE_ISSUES.map((issue) => ({
        updateOne: {
          // title + reporter is the natural key: stable across runs, so
          // re-seeding updates rather than duplicates.
          filter: {
            title: issue.title,
            reportedBy: usersByEmail.get(issue.reporterEmail),
          },
          update: {
            $set: {
              title: issue.title,
              description: issue.description,
              category: issue.category,
              location: issue.location,
              reportedBy: usersByEmail.get(issue.reporterEmail),
            },
          },
          upsert: true,
        },
      })),
    );

    report(
      `issues inserted: ${issueResult.upsertedCount}, updated: ${issueResult.modifiedCount}`,
    );
```

The `getModelToken` and `Model` imports already exist at the top of the file.

- [ ] **Step 2: Run the seed both ways**

```bash
docker compose up -d
npm run seed
npm run seed          # second run proves idempotency
npm run seed -- --fresh
```

Expected: the first run reports `issues inserted: 4`; the second reports
`inserted: 0` with a non-negative `updated` count and no duplicate-key error;
`--fresh` removes 4 and inserts 4.

- [ ] **Step 3: Document the endpoints**

In `README.md`, add this section immediately before `## Run tests`:

````markdown
## Issues

A citizen reports a civic issue; anyone can read the record; an agency triages it.

| Route | Access |
|---|---|
| `POST /issues` | `CITIZEN` |
| `GET /issues` | public — filters `status`, `category`, `reportedBy`; paging `limit` (default 20, max 100), `offset` |
| `GET /issues/:id` | public |
| `PATCH /issues/:id` | the reporter, while the issue is `OPEN` |
| `PATCH /issues/:id/status` | `AGENCY` or `ADMIN` |

Status changes happen in exactly one place, `IssueLifecycleService`. In this
slice an `OPEN` issue may become `REJECTED` (a `reason` is required) or
`DUPLICATE` (a `duplicateOf` id is required); every other transition returns
409. Claiming and resolution are a later slice.

```bash
TOKEN=$(curl -s -X POST localhost:9000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"citizen@civicon.test","password":"Password123!"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

curl -s -X POST localhost:9000/issues -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Blocked drain","description":"Standing water.","category":"DRAINAGE","location":"Market Street"}'
```
````

- [ ] **Step 4: Full verification**

```bash
npm run format && npm run lint
npm run build
npm run test
npm run test:e2e
```

Expected: all clean, all passing.

- [ ] **Step 5: Commit**

```bash
git add src/seed.ts README.md
git commit -m "Seed sample issues and document the reporting endpoints"
```
