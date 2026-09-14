import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';

/** Tuned for a demo-scale deployment; raise if hardware allows. */
const DEFAULT_COST_FACTOR = 12;

/**
 * Below this, bcrypt stops being meaningfully expensive. A misconfigured
 * BCRYPT_COST must not be able to weaken production silently, so a value under
 * the floor is honoured only when NODE_ENV is 'test' — which is the only
 * situation the override exists for.
 */
const MINIMUM_COST_FACTOR = 10;
const TEST_MINIMUM_COST_FACTOR = 4;

/**
 * Isolated from AuthService so the algorithm is a one-file change. bcryptjs is
 * pure JavaScript, so the Docker image needs no build toolchain.
 */
@Injectable()
export class PasswordService {
  private readonly costFactor: number;

  constructor(configService: ConfigService) {
    this.costFactor = PasswordService.resolveCost(
      configService.get<string>('BCRYPT_COST'),
    );
  }

  /**
   * BCRYPT_COST exists for test suites, which would otherwise pay roughly a
   * second per hash — the difference between a suite that runs in seconds and
   * one that runs in minutes. Anything missing, unparseable or below the
   * applicable floor falls back to the production default rather than
   * weakening it, and the low floor applies only under NODE_ENV=test.
   */
  private static resolveCost(configured: string | undefined): number {
    const parsed = Number(configured);
    const floor =
      process.env.NODE_ENV === 'test'
        ? TEST_MINIMUM_COST_FACTOR
        : MINIMUM_COST_FACTOR;

    if (!Number.isInteger(parsed) || parsed < floor) {
      return DEFAULT_COST_FACTOR;
    }
    return parsed;
  }

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.costFactor);
  }

  // The cost is encoded in the hash, so a password hashed at a different cost
  // still verifies — existing credentials survive a change of factor.
  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
