import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
// `import type` is required: isolatedModules + emitDecoratorMetadata forbid a
// value import for a type referenced in a decorated signature.
import type { AuthenticatedUser } from '../auth/types/jwt-payload.js';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe.js';
import { Role } from '../contracts/index.js';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { ListIssuesQuery } from './dto/list-issues.query.js';
import { UpdateIssueDto } from './dto/update-issue.dto.js';
import { toPublicIssue } from './issue-response.js';
import { IssuesService } from './issues.service.js';

@Controller('issues')
export class IssuesController {
  constructor(private readonly issuesService: IssuesService) {}

  @Post()
  @Roles(Role.CITIZEN)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createIssueDto: CreateIssueDto,
  ) {
    return toPublicIssue(
      await this.issuesService.create(user.id, createIssueDto),
    );
  }

  // The civic record is readable without an account: a transparency platform
  // that requires a login is not one.
  @Public()
  @Get()
  async findAll(@Query() query: ListIssuesQuery) {
    const issues = await this.issuesService.findAll(query);
    return issues.map(toPublicIssue);
  }

  @Public()
  @Get(':id')
  async findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return toPublicIssue(await this.issuesService.findOne(id));
  }
  // Authenticated but no @Roles(): ownership is the requirement, and the
  // service enforces it.
  @Patch(':id')
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() updateIssueDto: UpdateIssueDto,
  ) {
    return toPublicIssue(
      await this.issuesService.updateOwn(id, user.id, updateIssueDto),
    );
  }
}
