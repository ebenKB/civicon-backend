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
