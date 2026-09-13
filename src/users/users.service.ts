import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Role } from '../contracts/index.js';
import { Model } from 'mongoose';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { User, UserDocument } from './schemas/user.schema.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  findAll(): Promise<UserDocument[]> {
    return this.userModel.find().exec();
  }

  async findOne(id: string): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException(`User with id "${id}" not found`);
    }
    return user;
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto,
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(id, updateUserDto, {
        returnDocument: 'after',
        runValidators: true,
      })
      .exec();
    if (!user) {
      throw new NotFoundException(`User with id "${id}" not found`);
    }
    return user;
  }

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
   * both grants and revokes.
   */
  async setRoles(id: string, roles: Role[]): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(
        id,
        { roles },
        { returnDocument: 'after', runValidators: true },
      )
      .exec();
    if (!user) {
      throw new NotFoundException(`User with id "${id}" not found`);
    }
    return user;
  }

  async remove(id: string): Promise<void> {
    const result = await this.userModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`User with id "${id}" not found`);
    }
  }
}
