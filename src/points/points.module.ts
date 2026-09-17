import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersModule } from '../users/users.module.js';
import { CivicPointsService } from './civic-points.service.js';
import {
  PointTransaction,
  PointTransactionSchema,
} from './schemas/point-transaction.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PointTransaction.name, schema: PointTransactionSchema },
    ]),
    UsersModule,
  ],
  providers: [CivicPointsService],
  exports: [CivicPointsService],
})
export class PointsModule {}
