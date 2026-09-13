import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe.js';
import { Role } from '../contracts/index.js';
import { SetRolesDto } from './dto/set-roles.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UsersService } from './users.service.js';

// User administration. Account creation lives at POST /auth/register — a second
// path here would produce users with no password, unable to log in.
@Controller('users')
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.usersService.update(id, updateUserDto);
  }

  // Separate from PATCH :id on purpose: UpdateUserDto has no `roles`, so the
  // general update route cannot be used to escalate privileges.
  @Patch(':id/roles')
  setRoles(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() setRolesDto: SetRolesDto,
  ) {
    return this.usersService.setRoles(id, setRolesDto.roles);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseObjectIdPipe) id: string) {
    return this.usersService.remove(id);
  }
}
