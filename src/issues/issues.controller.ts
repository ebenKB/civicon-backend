import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { ChangeStatusDto } from './dto/change-status.dto.js';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { ListIssuesQuery } from './dto/list-issues.query.js';
import { ResolveIssueDto } from './dto/resolve-issue.dto.js';
import { UpdateIssueDto } from './dto/update-issue.dto.js';
import { IssueLifecycleService } from './issue-lifecycle.service.js';
import { IssueMediaService } from './issue-media.service.js';
import { toPublicIssue } from './issue-response.js';
import { IssuesService } from './issues.service.js';

@Controller('issues')
export class IssuesController {
  constructor(
    private readonly issuesService: IssuesService,
    private readonly issueLifecycleService: IssueLifecycleService,
    private readonly issueMediaService: IssueMediaService,
  ) {}

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
    // One query for the whole page rather than one per issue.
    const media = await this.issueMediaService.listForMany(
      issues.map((issue) => issue._id.toString()),
    );
    return issues.map((issue) =>
      toPublicIssue(issue, media.get(issue._id.toString()) ?? []),
    );
  }

  @Public()
  @Get(':id')
  async findOne(@Param('id', ParseObjectIdPipe) id: string) {
    const issue = await this.issuesService.findOne(id);
    return toPublicIssue(issue, await this.issueMediaService.listFor(id));
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
  // Agencies remain the authoritative owners of an issue's state.
  @Patch(':id/status')
  @Roles(Role.AGENCY, Role.ADMIN)
  async changeStatus(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() changeStatusDto: ChangeStatusDto,
  ) {
    return toPublicIssue(
      await this.issueLifecycleService.changeStatus(id, changeStatusDto),
    );
  }
  // The route is the intent: none of these takes a status, so a client cannot
  // ask for a transition that does not belong to it.
  @Post(':id/claim')
  // 200, not the POST default of 201: these change an existing issue's
  // state, they do not create a resource.
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CITIZEN)
  async claim(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return toPublicIssue(await this.issueLifecycleService.claim(id, user.id));
  }

  // No @Roles(): holder-only, and the service enforces that. A role check here
  // would be redundant and would wrongly refuse a holder whose roles change.
  @Delete(':id/claim')
  async release(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return toPublicIssue(await this.issueLifecycleService.release(id, user.id));
  }

  @Post(':id/start')
  // 200, not the POST default of 201: these change an existing issue's
  // state, they do not create a resource.
  @HttpCode(HttpStatus.OK)
  async start(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return toPublicIssue(await this.issueLifecycleService.start(id, user.id));
  }

  @Post(':id/resolution')
  // 200, not the POST default of 201: these change an existing issue's
  // state, they do not create a resource.
  @HttpCode(HttpStatus.OK)
  async resolve(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() resolveIssueDto: ResolveIssueDto,
  ) {
    return toPublicIssue(
      await this.issueLifecycleService.resolve(id, user.id, resolveIssueDto),
    );
  }
}
