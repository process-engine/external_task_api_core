import * as bluebird from 'bluebird';
import * as moment from 'moment';

import * as EssentialProjectErrors from '@essential-projects/errors_ts';
import {IIAMService, IIdentity} from '@essential-projects/iam_contracts';

import {ExternalTask, IExternalTaskApi, IExternalTaskRepository} from '@process-engine/external_task_api_contracts';

export class ExternalTaskApiService implements IExternalTaskApi {

  private readonly _externalTaskRepository: IExternalTaskRepository;
  private readonly _iamService: IIAMService;

  constructor(externalTaskRepository: IExternalTaskRepository, iamService: IIAMService) {
    this._externalTaskRepository = externalTaskRepository;
    this._iamService = iamService;
  }

  public async fetchAndLockExternalTasks(identity: IIdentity,
                                         workerId: string,
                                         topicName: string,
                                         maxTasks: number,
                                         longPollingTimeout: number,
                                         lockDuration: number): Promise<Array<ExternalTask>> {

    const tasks: Array<ExternalTask> = await this._externalTaskRepository.fetchAvailableForProcessing(topicName, maxTasks);

    const lockExpirationTime: Date = this._getLockExpirationDate(lockDuration);

    const lockedTasks: Array<ExternalTask> =
      await bluebird.map(tasks, async(externalTask: ExternalTask): Promise<ExternalTask> => {
        return this._lockExternalTask(externalTask, workerId, lockExpirationTime);
      });

    return lockedTasks;
  }

  public async extendLock(identity: IIdentity, workerId: string, externalTaskId: string, additionalDuration: number): Promise<void> {

    const externalTask: ExternalTask = await this._externalTaskRepository.getById(externalTaskId);

    this._ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    const newLockExpirationTime: Date = this._getLockExpirationDate(additionalDuration);

    return this._externalTaskRepository.lockForWorker(workerId, externalTaskId, newLockExpirationTime);
  }

  public async handleBpmnError(identity: IIdentity, workerId: string, externalTaskId: string, errorCode: string): Promise<void> {

    const externalTask: ExternalTask = await this._externalTaskRepository.getById(externalTaskId);

    this._ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    const error: EssentialProjectErrors.InternalServerError =
      new EssentialProjectErrors.InternalServerError(`ExternalTask failed due to BPMN error with code ${errorCode}`);

    return this._externalTaskRepository.finishWithError(externalTaskId, error);
  }

  public async handleServiceError(identity: IIdentity,
                                  workerId: string,
                                  externalTaskId: string,
                                  errorMessage: string,
                                  errorDetails: string): Promise<void> {

    const externalTask: ExternalTask = await this._externalTaskRepository.getById(externalTaskId);

    this._ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    const error: EssentialProjectErrors.InternalServerError = new EssentialProjectErrors.InternalServerError(errorMessage);
    error.additionalInformation = errorDetails;

    return this._externalTaskRepository.finishWithError(externalTaskId, error);
  }

  public async finishExternalTask(identity: IIdentity, workerId: string, externalTaskId: string, payload: any): Promise<void> {

    const externalTask: ExternalTask = await this._externalTaskRepository.getById(externalTaskId);

    this._ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    return this._externalTaskRepository.finishWithSuccess(externalTaskId, payload);
  }

  /**
   * Locks the given external task for the given Worker until the given
   * expiration time.
   *
   * @async
   * @param workerId           The ID of the worker for which to lock the
   *                           ExternalTask.
   * @param externalTaskId     The ID of the ExternalTask to lock.
   * @param lockExpirationTime The time at which to lock will be released.
   */
  private async _lockExternalTask(externalTask: ExternalTask, workerId: string, lockExpirationTime: Date): Promise<ExternalTask> {

    await this._externalTaskRepository.lockForWorker(workerId, externalTask.id, lockExpirationTime);

    externalTask.workerId = workerId;
    externalTask.lockExpirationTime = lockExpirationTime;

    return externalTask;
  }

  /**
   * Ensures that the given worker is authorized to access the given ExternalTask.
   *
   * @param externalTask   The ExternalTask for which to validate access rights.
   * @param externalTaskId The ExternalTaskID the worker attempted to query.
   * @param workerId       The ID of the worker attempting to manipulate the
   *                       ExternalTask.
   */
  private _ensureExternalTaskCanBeAccessedByWorker(externalTask: ExternalTask, externalTaskId: string, workerId: string): void {

    if (!externalTask) {
      throw new EssentialProjectErrors.NotFoundError(`External Task with ID '${externalTaskId}' not found.`);
    }

    if (externalTask.isFinished) {
      throw new EssentialProjectErrors.GoneError(`External Task with ID '${externalTaskId}' has been finished and is no longer accessible.`);
    }

    const now: moment.Moment = moment();
    const taskReleaseTime: moment.Moment = moment(externalTask.lockExpirationTime);

    const externalTaskIsLockedByOtherWorker: boolean = externalTask.workerId !== workerId && now.isBefore(taskReleaseTime);
    if (externalTaskIsLockedByOtherWorker) {
      const msg: string = `External Task with ID '${externalTaskId}' is locked by another worker, until ${taskReleaseTime.toISOString()}.`;
      throw new EssentialProjectErrors.LockedError(msg);
    }
  }

  private _getLockExpirationDate(duration: number): Date {
    return moment().add(duration, 'milliseconds').toDate();
  }
}
