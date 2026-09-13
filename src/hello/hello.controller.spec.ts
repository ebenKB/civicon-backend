import { Test, TestingModule } from '@nestjs/testing';
import { HelloController } from './hello.controller.js';
import { HelloService } from './hello.service.js';

describe('HelloController', () => {
  let controller: HelloController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HelloController],
      providers: [HelloService],
    }).compile();

    controller = module.get<HelloController>(HelloController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return "hello world"', () => {
    expect(controller.getHello()).toBe('hello world');
  });
});
