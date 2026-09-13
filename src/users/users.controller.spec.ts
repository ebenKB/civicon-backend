import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '../contracts/index.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

describe('UsersController', () => {
  let controller: UsersController;
  let service: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    service = {
      findAll: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      setRoles: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: service }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates a role grant to the service', async () => {
    service.setRoles.mockResolvedValue({ roles: [Role.AGENCY] });

    await controller.setRoles('507f1f77bcf86cd799439011', {
      roles: [Role.AGENCY],
    });

    expect(service.setRoles).toHaveBeenCalledWith('507f1f77bcf86cd799439011', [
      Role.AGENCY,
    ]);
  });

  it('delegates findAll to the service', async () => {
    service.findAll.mockResolvedValue([]);

    await expect(controller.findAll()).resolves.toEqual([]);
    expect(service.findAll).toHaveBeenCalled();
  });
});
