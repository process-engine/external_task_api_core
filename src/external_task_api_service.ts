import * as moment from 'moment';

import * as EssentialProjectErrors from '@essential-projects/errors_ts';
import {IEventAggregator, Subscription} from '@essential-projects/event_aggregator_contracts';
import {IIAMService, IIdentity} from '@essential-projects/iam_contracts';

import {
  ExternalTask,
  ExternalTaskErrorMessage,
  ExternalTaskState,
  ExternalTaskSuccessMessage,
  IExternalTaskApi,
  IExternalTaskRepository,
} from '@process-engine/external_task_api_contracts';

export class ExternalTaskApiService implements IExternalTaskApi {

  private readonly _eventAggregator: IEventAggregator;
  private readonly _externalTaskRepository: IExternalTaskRepository;
  private readonly _iamService: IIAMService;

  private readonly _canAccessExternalTasksClaim: string = 'can_access_external_tasks';

  constructor(eventAggregator: IEventAggregator, externalTaskRepository: IExternalTaskRepository, iamService: IIAMService) {
    this._eventAggregator = eventAggregator;
    this._externalTaskRepository = externalTaskRepository;
    this._iamService = iamService;
  }

  public async fetchAndLockExternalTasks<TPayload>(identity: IIdentity,
                                                   workerId: string,
                                                   topicName: string,
                                                   maxTasks: number,
                                                   longPollingTimeout: number,
                                                   lockDuration: number,
                                                  ): Promise<Array<ExternalTask<TPayload>>> {

    await this._iamService.ensureHasClaim(identity, this._canAccessExternalTasksClaim);

    const tasks: Array<ExternalTask<TPayload>> = await this._fetchOrWaitForExternalTasks<TPayload>(topicName, maxTasks, longPollingTimeout);

    const lockExpirationTime: Date = this._getLockExpirationDate(lockDuration);

    const lockedTasks: Array<ExternalTask<TPayload>> =
      await Promise.map(tasks, async(externalTask: ExternalTask<TPayload>): Promise<ExternalTask<TPayload>> => {
        return this._lockExternalTask(externalTask, workerId, lockExpirationTime);
      });

    return lockedTasks;
  }

  public async extendLock(identity: IIdentity, workerId: string, externalTaskId: string, additionalDuration: number): Promise<void> {

    await this._iamService.ensureHasClaim(identity, this._canAccessExternalTasksClaim);

    // Note: The type of the initial payload is irrelevant for lock extension.
    const externalTask: ExternalTask<any> = await this._externalTaskRepository.getById<any>(externalTaskId);

    this._ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    const newLockExpirationTime: Date = this._getLockExpirationDate(additionalDuration);

    return this._externalTaskRepository.lockForWorker(workerId, externalTaskId, newLockExpirationTime);
  }

  public async handleBpmnError(identity: IIdentity, workerId: string, externalTaskId: string, errorCode: string): Promise<void> {

    await this._iamService.ensureHasClaim(identity, this._canAccessExternalTasksClaim);

    // Note: The type of the initial payload is irrelevant for finishing with an error.
    const externalTask: ExternalTask<any> = await this._externalTaskRepository.getById<any>(externalTaskId);

    this._ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    const error: EssentialProjectErrors.InternalServerError =
      new EssentialProjectErrors.InternalServerError(`ExternalTask failed due to BPMN error with code ${errorCode}`);

    await this._externalTaskRepository.finishWithError(externalTaskId, error);

    const errorNotificationPayload: ExternalTaskErrorMessage = new ExternalTaskErrorMessage(error);

    this._publishExternalTaskFinishedMessage(externalTask, errorNotificationPayload);
  }

  public async handleServiceError(identity: IIdentity,
                                  workerId: string,
                                  externalTaskId: string,
                                  errorMessage: string,
                                  errorDetails: string,
                                 ): Promise<void> {

    await this._iamService.ensureHasClaim(identity, this._canAccessExternalTasksClaim);

    // Note: The type of the initial payload is irrelevant for finishing with an error.
    const externalTask: ExternalTask<any> = await this._externalTaskRepository.getById<any>(externalTaskId);

    this._ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    const error: EssentialProjectErrors.InternalServerError = new EssentialProjectErrors.InternalServerError(errorMessage);
    error.additionalInformation = errorDetails;

    await this._externalTaskRepository.finishWithError(externalTaskId, error);

    const errorNotificationPayload: ExternalTaskErrorMessage = new ExternalTaskErrorMessage(error);

    this._publishExternalTaskFinishedMessage(externalTask, errorNotificationPayload);
  }

  public async finishExternalTask<TResultType>(identity: IIdentity,
                                               workerId: string,
                                               externalTaskId: string,
                                               payload: TResultType,
                                              ): Promise<void> {

    await this._iamService.ensureHasClaim(identity, this._canAccessExternalTasksClaim);

    // Note: The type of the initial payload is irrelevant for providing a final result.
    const externalTask: ExternalTask<any> = await this._externalTaskRepository.getById<any>(externalTaskId);

    this._ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    await this._externalTaskRepository.finishWithSuccess<TResultType>(externalTaskId, payload);

    const successNotificationPayload: ExternalTaskSuccessMessage = new ExternalTaskSuccessMessage(payload);

    this._publishExternalTaskFinishedMessage(externalTask, successNotificationPayload);
  }

  private async _fetchOrWaitForExternalTasks<TPayload>(topicName: string,
                                                       maxTasks: number,
                                                       longPollingTimeout: number,
                                                      ): Promise<Array<ExternalTask<TPayload>>> {

    return new Promise<Array<ExternalTask<TPayload>>>(async(resolve: Function): Promise<void> => {

      const tasks: Array<ExternalTask<TPayload>> =
        await this._externalTaskRepository.fetchAvailableForProcessing<TPayload>(topicName, maxTasks);

      const taskAreNotEmpty: boolean = tasks.length > 0;

      if (taskAreNotEmpty) {
        return resolve(tasks);
      }

      let subscription: Subscription;

      const timeout: NodeJS.Timeout = setTimeout(() => {
        this._eventAggregator.unsubscribe(subscription);

        return resolve([]);
      }, longPollingTimeout);

      const externalTaskCreatedEventName: string = `/externaltask/topic/${topicName}/created`;
      subscription = this._eventAggregator.subscribeOnce(externalTaskCreatedEventName, async(): Promise<void> => {

        clearTimeout(timeout);

        const availableTasks: Array<ExternalTask<TPayload>> =
          await this._externalTaskRepository.fetchAvailableForProcessing<TPayload>(topicName, maxTasks);

        return resolve(availableTasks);
      });
    });
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
   * @returns                  The clocked ExternalTask.
   */
  private async _lockExternalTask(externalTask: ExternalTask<any>, workerId: string, lockExpirationTime: Date): Promise<ExternalTask<any>> {

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
  private _ensureExternalTaskCanBeAccessedByWorker(externalTask: ExternalTask<any>, externalTaskId: string, workerId: string): void {

    const externalTaskDoesNotExist: boolean = !externalTask;
    if (externalTaskDoesNotExist) {
      throw new EssentialProjectErrors.NotFoundError(`External Task with ID '${externalTaskId}' not found.`);
    }

    const externalTaskIsAlreadyFinished: boolean = externalTask.state === ExternalTaskState.finished;
    if (externalTaskIsAlreadyFinished) {
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

  /**
   * Takes the given duration in ms and adds it to the current datetime.
   * The result is returned as a date which can be used as an unlock date.
   *
   * @param   duration The duration in ms to use for the new unlock date.
   * @returns          The calculated lockout date.
   */
  private _getLockExpirationDate(duration: number): Date {
    return moment().add(duration, 'milliseconds').toDate();
  }

  /**
   * Publishes a message to the EventAggregator, which notifies about a finished
   * ExternalTask.
   *
   * @param externalTask The ExternalTask for which to publish a notification.
   * @param result       The result of the ExternalTask's execution.
   */
  private _publishExternalTaskFinishedMessage(externalTask: ExternalTask<any>, result: any): void {

    const externalTaskFinishedEventName: string = `/externaltask/flownodeinstance/${externalTask.flowNodeInstanceId}/finished`;

    this._eventAggregator.publish(externalTaskFinishedEventName, result);
  }
}
