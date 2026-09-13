import { NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Role } from '../contracts/index.js';
import { Test, TestingModule } from '@nestjs/testing';
import { User } from './schemas/user.schema.js';
import { UsersService } from './users.service.js';

// Mongoose queries are thenable builders, so each mock returns an object with
// .exec() rather than a bare promise.
const execOf = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('UsersService', () => {
  let service: UsersService;
  let model: {
    create: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    findByIdAndUpdate: ReturnType<typeof vi.fn>;
    findByIdAndDelete: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    model = {
      create: vi.fn(),
      find: vi.fn(),
      findById: vi.fn(),
      findOne: vi.fn(),
      findByIdAndUpdate: vi.fn(),
      findByIdAndDelete: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getModelToken(User.name), useValue: model },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('creates a user with a password hash', async () => {
    const input = {
      name: 'Ada',
      email: 'ada@example.com',
      passwordHash: 'hashed',
      roles: [Role.CITIZEN],
    };
    model.create.mockResolvedValue({ ...input, _id: '1' });

    await expect(service.createWithPassword(input)).resolves.toMatchObject(
      input,
    );
    expect(model.create).toHaveBeenCalledWith(input);
  });

  it('lists users', async () => {
    model.find.mockReturnValue(execOf([{ name: 'Ada' }]));

    await expect(service.findAll()).resolves.toHaveLength(1);
  });

  it('throws NotFoundException when a user is missing', async () => {
    model.findById.mockReturnValue(execOf(null));

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws NotFoundException when updating a missing user', async () => {
    model.findByIdAndUpdate.mockReturnValue(execOf(null));

    await expect(
      service.update('missing', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException when removing a missing user', async () => {
    model.findByIdAndDelete.mockReturnValue(execOf(null));

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('finds a user by email with the password hash', async () => {
    const select = vi
      .fn()
      .mockReturnValue(execOf({ email: 'ada@example.com' }));
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
});
