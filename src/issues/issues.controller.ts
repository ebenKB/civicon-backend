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
import { SetHazardDto } from './dto/set-hazard.dto.js';
import { SubmitClassificationDto } from './dto/submit-classification.dto.js';
import { UpdateIssueDto } from './dto/update-issue.dto.js';
import { IssueHazardService } from './issue-hazard.service.js';
import { IssueLifecycleService } from './issue-lifecycle.service.js';
import { IssueMediaService } from './issue-media.service.js';
import { toPublicIssue } from './issue-response.js';
import type { PublicIssue } from './issue-response.js';
import type { IssueDocument } from './schemas/issue.schema.js';
import { IssuesService } from './issues.service.js';
import { UsersService } from '../users/users.service.js';

@Controller('issues')
export class IssuesController {
  constructor(
    private readonly issuesService: IssuesService,
    private readonly issueLifecycleService: IssueLifecycleService,
    private readonly issueMediaService: IssueMediaService,
    private readonly issueHazardService: IssueHazardService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * The single way an issue leaves this controller. Every route goes through
   * it, so a response cannot quietly differ by which one produced it — the
   * mutation routes used to answer with an empty media list however many
   * photographs the issue carried.
   */
  private async present(issue: IssueDocument): Promise<PublicIssue> {
    const id = issue._id.toString();
    const volunteerId = issue.volunteerId?.toString();

    const [media, names] = await Promise.all([
      this.issueMediaService.listFor(id),
      this.usersService.namesFor(volunteerId ? [volunteerId] : []),
    ]);

    return toPublicIssue(issue, media, volunteerId && names.get(volunteerId));
  }

  @Post()
  @Roles(Role.CITIZEN)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createIssueDto: CreateIssueDto,
  ) {
    return this.present(
      await this.issuesService.create(user.id, createIssueDto),
    );
  }

  // The civic record is readable without an account: a transparency platform
  // that requires a login is not one.
  @Public()
  @Get()
  async findAll(@Query() query: ListIssuesQuery) {
    const issues = await this.issuesService.findAll(query);
    // Two queries for the whole page rather than two per issue.
    const [media, names] = await Promise.all([
      this.issueMediaService.listForMany(
        issues.map((issue) => issue._id.toString()),
      ),
      this.usersService.namesFor(
        issues
          .map((issue) => issue.volunteerId?.toString())
          .filter((id): id is string => id !== undefined),
      ),
    ]);

    return issues.map((issue) => {
      const volunteerId = issue.volunteerId?.toString();
      return toPublicIssue(
        issue,
        media.get(issue._id.toString()) ?? [],
        volunteerId && names.get(volunteerId),
      );
    });
  }

  @Public()
  @Get(':id')
  async findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.present(await this.issuesService.findOne(id));
  }
  // Authenticated but no @Roles(): ownership is the requirement, and the
  // service enforces it.
  @Patch(':id')
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() updateIssueDto: UpdateIssueDto,
  ) {
    return this.present(
      await this.issuesService.updateOwn(id, user.id, updateIssueDto),
    );
  }
  // Agencies remain the authoritative owners of an issue's state.
  @Patch(':id/status')
  @Roles(Role.AGENCY, Role.ADMIN)
  async changeStatus(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() changeStatusDto: ChangeStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.present(
      await this.issueLifecycleService.changeStatus(
        id,
        changeStatusDto,
        user.id,
      ),
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
    return this.present(await this.issueLifecycleService.claim(id, user.id));
  }

  // No @Roles(): holder-only, and the service enforces that. A role check here
  // would be redundant and would wrongly refuse a holder whose roles change.
  @Delete(':id/claim')
  async release(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.present(await this.issueLifecycleService.release(id, user.id));
  }

  @Post(':id/start')
  // 200, not the POST default of 201: these change an existing issue's
  // state, they do not create a resource.
  @HttpCode(HttpStatus.OK)
  async start(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.present(await this.issueLifecycleService.start(id, user.id));
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
    return this.present(
      await this.issueLifecycleService.resolve(id, user.id, resolveIssueDto),
    );
  }

  /**
   * Step 3 of reporting: classify. Called once with no body, then again with
   * answers if the first call came back with questions.
   */
  @Post(':id/classification')
  @HttpCode(HttpStatus.OK)
  async classify(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() submitClassificationDto: SubmitClassificationDto,
  ) {
    return this.present(
      await this.issueHazardService.submit(id, user.id, submitClassificationDto),
    );
  }

  @Patch(':id/hazard')
  @Roles(Role.AGENCY, Role.ADMIN)
  async setHazard(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() setHazardDto: SetHazardDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.present(
      await this.issueHazardService.setLevel(id, user.id, user.roles, setHazardDto),
    );
  }
}
