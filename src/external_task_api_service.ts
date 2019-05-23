/* eslint-disable no-param-reassign */
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

  private readonly eventAggregator: IEventAggregator;
  private readonly externalTaskRepository: IExternalTaskRepository;
  private readonly iamService: IIAMService;

  private readonly canAccessExternalTasksClaim = 'can_access_external_tasks';

  constructor(eventAggregator: IEventAggregator, externalTaskRepository: IExternalTaskRepository, iamService: IIAMService) {
    this.eventAggregator = eventAggregator;
    this.externalTaskRepository = externalTaskRepository;
    this.iamService = iamService;
  }

  public async fetchAndLockExternalTasks<TPayload>(
    identity: IIdentity,
    workerId: string,
    topicName: string,
    maxTasks: number,
    longPollingTimeout: number,
    lockDuration: number,
  ): Promise<Array<ExternalTask<TPayload>>> {

    await this.iamService.ensureHasClaim(identity, this.canAccessExternalTasksClaim);

    const tasks = await this.fetchOrWaitForExternalTasks<TPayload>(topicName, maxTasks, longPollingTimeout);

    const lockExpirationTime = this.getLockExpirationDate(lockDuration);

    const lockedTasks = await Promise.map(tasks, async (externalTask: ExternalTask<TPayload>): Promise<ExternalTask<TPayload>> => {
      return this.lockExternalTask(externalTask, workerId, lockExpirationTime);
    });

    return lockedTasks;
  }

  public async extendLock(identity: IIdentity, workerId: string, externalTaskId: string, additionalDuration: number): Promise<void> {

    await this.iamService.ensureHasClaim(identity, this.canAccessExternalTasksClaim);

    // Note: The type of the initial payload is irrelevant for lock extension.
    const externalTask = await this.externalTaskRepository.getById(externalTaskId);

    this.ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    const newLockExpirationTime = this.getLockExpirationDate(additionalDuration);

    return this.externalTaskRepository.lockForWorker(workerId, externalTaskId, newLockExpirationTime);
  }

  public async handleBpmnError(identity: IIdentity, workerId: string, externalTaskId: string, errorCode: string): Promise<void> {

    await this.iamService.ensureHasClaim(identity, this.canAccessExternalTasksClaim);

    // Note: The type of the initial payload is irrelevant for finishing with an error.
    const externalTask = await this.externalTaskRepository.getById(externalTaskId);

    this.ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    const error = new EssentialProjectErrors.InternalServerError(`ExternalTask failed due to BPMN error with code ${errorCode}`);

    await this.externalTaskRepository.finishWithError(externalTaskId, error);

    const errorNotificationPayload = new ExternalTaskErrorMessage(error);

    this.publishExternalTaskFinishedMessage(externalTask, errorNotificationPayload);
  }

  public async handleServiceError(
    identity: IIdentity,
    workerId: string,
    externalTaskId: string,
    errorMessage: string,
    errorDetails: string,
  ): Promise<void> {

    await this.iamService.ensureHasClaim(identity, this.canAccessExternalTasksClaim);

    const externalTask = await this.externalTaskRepository.getById(externalTaskId);

    this.ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    const error = new EssentialProjectErrors.InternalServerError(errorMessage);
    error.additionalInformation = errorDetails;

    await this.externalTaskRepository.finishWithError(externalTaskId, error);

    const errorNotificationPayload = new ExternalTaskErrorMessage(error);

    this.publishExternalTaskFinishedMessage(externalTask, errorNotificationPayload);
  }

  public async finishExternalTask<TResultType>(
    identity: IIdentity,
    workerId: string,
    externalTaskId: string,
    payload: TResultType,
  ): Promise<void> {

    await this.iamService.ensureHasClaim(identity, this.canAccessExternalTasksClaim);

    const externalTask = await this.externalTaskRepository.getById(externalTaskId);

    this.ensureExternalTaskCanBeAccessedByWorker(externalTask, externalTaskId, workerId);

    await this.externalTaskRepository.finishWithSuccess<TResultType>(externalTaskId, payload);

    const successNotificationPayload = new ExternalTaskSuccessMessage(payload);

    this.publishExternalTaskFinishedMessage(externalTask, successNotificationPayload);
  }

  private async fetchOrWaitForExternalTasks<TPayload>(
    topicName: string,
    maxTasks: number,
    longPollingTimeout: number,
  ): Promise<Array<ExternalTask<TPayload>>> {

    // eslint-disable-next-line consistent-return
    return new Promise<Array<ExternalTask<TPayload>>>(async (resolve: Function): Promise<void> => {

      const tasks = await this.externalTaskRepository.fetchAvailableForProcessing<TPayload>(topicName, maxTasks);

      const taskAreNotEmpty = tasks.length > 0;

      if (taskAreNotEmpty) {
        return resolve(tasks);
      }

      let subscription: Subscription;

      const timeout = setTimeout((): void => {
        this.eventAggregator.unsubscribe(subscription);

        return resolve([]);
      }, longPollingTimeout);

      const externalTaskCreatedEventName = `/externaltask/topic/${topicName}/created`;
      subscription = this.eventAggregator.subscribeOnce(externalTaskCreatedEventName, async (): Promise<void> => {

        clearTimeout(timeout);

        const availableTasks = await this.externalTaskRepository.fetchAvailableForProcessing<TPayload>(topicName, maxTasks);

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
  private async lockExternalTask(externalTask: ExternalTask<any>, workerId: string, lockExpirationTime: Date): Promise<ExternalTask<any>> {

    await this.externalTaskRepository.lockForWorker(workerId, externalTask.id, lockExpirationTime);

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
  private ensureExternalTaskCanBeAccessedByWorker(externalTask: ExternalTask<any>, externalTaskId: string, workerId: string): void {

    const externalTaskDoesNotExist = !externalTask;
    if (externalTaskDoesNotExist) {
      throw new EssentialProjectErrors.NotFoundError(`External Task with ID '${externalTaskId}' not found.`);
    }

    const externalTaskIsAlreadyFinished = externalTask.state === ExternalTaskState.finished;
    if (externalTaskIsAlreadyFinished) {
      throw new EssentialProjectErrors.GoneError(`External Task with ID '${externalTaskId}' has been finished and is no longer accessible.`);
    }

    const now = moment();
    const taskReleaseTime = moment(externalTask.lockExpirationTime);

    const externalTaskIsLockedByOtherWorker = externalTask.workerId !== workerId && now.isBefore(taskReleaseTime);
    if (externalTaskIsLockedByOtherWorker) {
      const msg = `External Task with ID '${externalTaskId}' is locked by another worker, until ${taskReleaseTime.toISOString()}.`;
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
  private getLockExpirationDate(duration: number): Date {
    return moment().add(duration, 'milliseconds')
      .toDate();
  }

  /**
   * Publishes a message to the EventAggregator, which notifies about a finished
   * ExternalTask.
   *
   * @param externalTask The ExternalTask for which to publish a notification.
   * @param result       The result of the ExternalTask's execution.
   */
  private publishExternalTaskFinishedMessage(externalTask: ExternalTask<any>, result: any): void {

    const externalTaskFinishedEventName = `/externaltask/flownodeinstance/${externalTask.flowNodeInstanceId}/finished`;

    this.eventAggregator.publish(externalTaskFinishedEventName, result);
  }

}
