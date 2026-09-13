import { Test, TestingModule } from '@nestjs/testing';
import { HelloService } from './hello.service.js';

describe('HelloService', () => {
  let service: HelloService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HelloService],
    }).compile();

    service = module.get<HelloService>(HelloService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return "hello world"', () => {
    expect(service.getHello()).toBe('hello world');
  });
});
