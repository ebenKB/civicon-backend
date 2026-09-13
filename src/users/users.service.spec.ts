import { NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
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
    findByIdAndUpdate: ReturnType<typeof vi.fn>;
    findByIdAndDelete: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    model = {
      create: vi.fn(),
      find: vi.fn(),
      findById: vi.fn(),
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

  it('creates a user', async () => {
    const dto = { name: 'Ada', email: 'ada@example.com' };
    model.create.mockResolvedValue({ ...dto, _id: '1' });

    await expect(service.create(dto)).resolves.toMatchObject(dto);
    expect(model.create).toHaveBeenCalledWith(dto);
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
});
