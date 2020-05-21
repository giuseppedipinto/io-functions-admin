/**
 * This activity extracts all the data about a user contained in our db.
 */

import * as t from "io-ts";

import { sequenceT } from "fp-ts/lib/Apply";
import { array } from "fp-ts/lib/Array";
import { Either, left } from "fp-ts/lib/Either";
import {
  fromEither,
  TaskEither,
  taskEither,
  taskEitherSeq,
  taskify,
  tryCatch
} from "fp-ts/lib/TaskEither";

import { Context } from "@azure/functions";

import { BlobService } from "azure-storage";
import { QueryError } from "documentdb";
import { MessageContent } from "io-functions-commons/dist/generated/definitions/MessageContent";
import {
  RetrievedMessageWithContent,
  RetrievedMessageWithoutContent
} from "io-functions-commons/dist/src/models/message";
import { RetrievedMessageStatus } from "io-functions-commons/dist/src/models/message_status";
import { NotificationStatusModel } from "io-functions-commons/dist/src/models/notification_status";
import { RetrievedProfile } from "io-functions-commons/dist/src/models/profile";
import { UserDataProcessingId } from "io-functions-commons/dist/src/models/user_data_processing";
import {
  IResultIterator,
  iteratorToArray
} from "io-functions-commons/dist/src/utils/documentdb";
import { readableReport } from "italia-ts-commons/lib/reporters";
import { FiscalCode, NonEmptyString } from "italia-ts-commons/lib/strings";
import { MessageModel } from "./models/message";
import { MessageStatusModel } from "./models/message_status";
import { NotificationModel } from "./models/notification";
import { ProfileModel } from "./models/profile";

// Activity input
export const ActivityInput = t.interface({
  fiscalCode: FiscalCode,
  userDataDeleteRequestId: UserDataProcessingId
});
export type ActivityInput = t.TypeOf<typeof ActivityInput>;

// Activity success result
export const ActivityResultSuccess = t.interface({
  kind: t.literal("SUCCESS")
});
export type ActivityResultSuccess = t.TypeOf<typeof ActivityResultSuccess>;

// Activity failed because of invalid input
export const InvalidInputFailure = t.interface({
  kind: t.literal("INVALID_INPUT_FAILURE"),
  reason: t.string
});
export type InvalidInputFailure = t.TypeOf<typeof InvalidInputFailure>;

// Activity failed because of an error on a query
export const QueryFailure = t.intersection([
  t.interface({
    kind: t.literal("QUERY_FAILURE"),
    reason: t.string
  }),
  t.partial({ query: t.string })
]);
export type QueryFailure = t.TypeOf<typeof QueryFailure>;

// activity failed for user not found
export const UserNotFound = t.interface({
  kind: t.literal("USER_NOT_FOUND_FAILURE")
});
export type UserNotFound = t.TypeOf<typeof UserNotFound>;

// activity failed while deleting a document from the db
export const DocumentDeleteFailure = t.interface({
  kind: t.literal("DELETE_FAILURE"),
  reason: t.string
});
export type DocumentDeleteFailure = t.TypeOf<typeof DocumentDeleteFailure>;

// activity failed while creating a new blob on storage
export const BlobCreationFailure = t.interface({
  kind: t.literal("BLOB_FAILURE"),
  reason: t.string
});
export type BlobCreationFailure = t.TypeOf<typeof BlobCreationFailure>;

export const ActivityResultFailure = t.taggedUnion("kind", [
  UserNotFound,
  QueryFailure,
  InvalidInputFailure,
  BlobCreationFailure,
  DocumentDeleteFailure
]);
export type ActivityResultFailure = t.TypeOf<typeof ActivityResultFailure>;

export const ActivityResult = t.taggedUnion("kind", [
  ActivityResultSuccess,
  ActivityResultFailure
]);
export type ActivityResult = t.TypeOf<typeof ActivityResult>;

const logPrefix = `DeleteUserDataActivity`;

/**
 * Converts a Promise<Either> into a TaskEither
 * This is needed because our models return unconvenient type. Both left and rejection cases are handled as a TaskEither left
 * @param lazyPromise a lazy promise to convert
 * @param queryName an optional name for the query, for logging purpose
 *
 * @returns either the query result or a query failure
 */
const fromQueryEither = <R>(
  lazyPromise: () => Promise<Either<QueryError | Error, R>>,
  queryName: string = ""
): TaskEither<QueryFailure, R> =>
  tryCatch(lazyPromise, (err: Error) =>
    QueryFailure.encode({
      kind: "QUERY_FAILURE",
      query: queryName,
      reason: err.message
    })
  ).chain((queryErrorOrRecord: Either<QueryError | Error, R>) =>
    fromEither(
      queryErrorOrRecord.mapLeft(queryError =>
        QueryFailure.encode({
          kind: "QUERY_FAILURE",
          query: queryName,
          reason: JSON.stringify(queryError)
        })
      )
    )
  );

/**
 * To be used for exhaustive checks
 */
function assertNever(_: never): void {
  throw new Error("should not have executed this");
}

/**
 * to cast an error as QueryError, useful for tryCatch statements
 * @param err a query error
 */
const toQueryError = (err: QueryError) => err;
/**
 * to cast an error to a ActivityResultQueryFailure
 * @param err
 */
const toQueryFailure = (err: QueryError): QueryFailure =>
  QueryFailure.encode({
    kind: "QUERY_FAILURE",
    reason: err.body
  });

/**
 * Logs depending on failure type
 * @param context the Azure functions context
 * @param failure the failure to log
 */
const logFailure = (context: Context) => (
  failure: ActivityResultFailure
): void => {
  switch (failure.kind) {
    case "INVALID_INPUT_FAILURE":
      context.log.error(
        `${logPrefix}|Error decoding input|ERROR=${failure.reason}`
      );
      break;
    case "QUERY_FAILURE":
      context.log.error(
        `${logPrefix}|Error ${failure.query} query error|ERROR=${failure.reason}`
      );
      break;
    case "BLOB_FAILURE":
      context.log.error(
        `${logPrefix}|Error saving zip bundle|ERROR=${failure.reason}`
      );
      break;
    case "USER_NOT_FOUND_FAILURE":
      context.log.error(`${logPrefix}|Error user not found|ERROR=`);
      break;
    case "DELETE_FAILURE":
      context.log.error(
        `${logPrefix}|Error deleting data|ERROR=${failure.reason}`
      );
      break;
    default:
      assertNever(failure);
  }
};

// define a value object with the info related to the blob storage for backup files
interface IBlobServiceInfo {
  blobService: BlobService;
  containerName: string;
  folder?: NonEmptyString;
}

/**
 * Saves data into a dedicated blob
 * @param blobServiceInfo references about where to save data
 * @param blobName name of the blob to be saved. It might not include a folder if specified in blobServiceInfo
 * @param data serializable data to be saved
 *
 * @returns either a blob failure or the saved object
 */
export const saveDataToBlob = <T>(
  { blobService, containerName, folder }: IBlobServiceInfo,
  blobName: string,
  data: T
): TaskEither<BlobCreationFailure, T> => {
  return taskify<BlobCreationFailure, T>(cb => {
    blobService.createBlockBlobFromText(
      containerName,
      `${folder}${folder ? "/" : ""}${blobName}`,
      JSON.stringify(data),
      err => {
        if (err) {
          cb(
            BlobCreationFailure.encode({
              kind: "BLOB_FAILURE",
              reason: err.message
            })
          );
        } else {
          cb(null, data);
        }
      }
    );
  })();
};

/**
 * Backup and delete every version of the profile
 *
 * @param param0.profileModel instance of ProfileModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.fiscalCode the identifier of the user
 */
const backupAndDeleteProfile = ({
  fiscalCode,
  profileModel,
  userDataBackup
}: {
  profileModel: ProfileModel;
  userDataBackup: IBlobServiceInfo;
  fiscalCode: FiscalCode;
}) => {
  // execute backup&delete for a single version record item
  const executeOnSingleVersionItem = (
    item: RetrievedProfile
  ): TaskEither<BlobCreationFailure | QueryFailure, RetrievedProfile> => {
    const sequencedTasks = sequenceT(taskEitherSeq)<
      BlobCreationFailure | QueryFailure,
      // tslint:disable-next-line: readonly-array
      [
        TaskEither<QueryFailure | BlobCreationFailure, RetrievedProfile>,
        TaskEither<QueryFailure | BlobCreationFailure, string>
      ]
    >(
      saveDataToBlob<RetrievedProfile>(
        userDataBackup,
        `profile--${item.version}.json`,
        item
      ),
      fromQueryEither(
        () => profileModel.deleteProfileVersion(item.fiscalCode, item.id),
        "deleteProfileVersion"
      )
    ).map(_ => item);

    return sequencedTasks.map(_ => item);
  };

  // recursively consumes an iterator and executes operations on every item
  const executeRecursiveOperations = (
    iterator: IResultIterator<RetrievedProfile>
  ): TaskEither<
    QueryFailure | BlobCreationFailure,
    // tslint:disable-next-line: readonly-array
    RetrievedProfile[]
  > => {
    const taskMaybeArrayOfMessageStatus = tryCatch(
      iterator.executeNext,
      toQueryError
    ).chain(fromEither);

    return taskMaybeArrayOfMessageStatus.foldTaskEither<
      QueryFailure | BlobCreationFailure,
      // tslint:disable-next-line: readonly-array
      RetrievedProfile[]
    >(
      e => fromEither(left(toQueryFailure(e))),
      maybeResults =>
        maybeResults.fold(
          // if the iterator content is none, exit the recursion
          taskEither.of([]),
          items =>
            // executes backup&delete for this set of items
            array
              .sequence(taskEither)(items.map(executeOnSingleVersionItem))
              // recursive step
              .chain(_ => executeRecursiveOperations(iterator))
        )
    );
  };

  return executeRecursiveOperations(
    profileModel.findAllVersionsByModelId(fiscalCode)
  );
};

/**
 * Backup and delete a given message
 *
 * @param param0.messageStatusModel instance of MessageStatusModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.message the message
 */
const backupAndDeleteMessage = ({
  messageModel,
  userDataBackup,
  message
}: {
  messageModel: MessageModel;
  userDataBackup: IBlobServiceInfo;
  message: RetrievedMessageWithoutContent;
}): TaskEither<
  BlobCreationFailure | QueryFailure,
  RetrievedMessageWithoutContent
> => {
  return sequenceT(taskEitherSeq)<
    QueryFailure | BlobCreationFailure,
    // tslint:disable-next-line: readonly-array
    [
      TaskEither<
        QueryFailure | BlobCreationFailure,
        RetrievedMessageWithoutContent
      >,
      TaskEither<QueryFailure | BlobCreationFailure, string>
    ]
  >(
    saveDataToBlob<RetrievedMessageWithoutContent>(
      userDataBackup,
      `message--${message.id}.json`,
      message
    ),
    fromQueryEither(
      () => messageModel.deleteMessage(message.fiscalCode, message.id),
      "deleteMessage"
    )
  ).map(_ => message);
};

const backupAndDeleteMessageContent = (): TaskEither<
  BlobCreationFailure | QueryFailure,
  MessageContent
> => taskEither.of({} as MessageContent);

/**
 * Find all versions of a message status, then backup and delete each document
 * @param param0.messageStatusModel instance of MessageStatusModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.message parent message
 *
 */
const backupAndDeleteMessageStatus = ({
  messageStatusModel,
  userDataBackup,
  message
}: {
  messageStatusModel: MessageStatusModel;
  userDataBackup: IBlobServiceInfo;
  message: RetrievedMessageWithoutContent;
}): TaskEither<
  QueryFailure | BlobCreationFailure,
  readonly RetrievedMessageStatus[]
> => {
  // execute backup&delete for a single version record item
  const executeOnSingleVersionItem = (
    item: RetrievedMessageStatus
  ): TaskEither<QueryFailure | BlobCreationFailure, RetrievedMessageStatus> => {
    return (
      sequenceT(taskEitherSeq)<
        QueryFailure | BlobCreationFailure,
        // tslint:disable-next-line: readonly-array
        [
          TaskEither<
            QueryFailure | BlobCreationFailure,
            RetrievedMessageStatus
          >,
          TaskEither<QueryFailure | BlobCreationFailure, string>
        ]
      >(
        saveDataToBlob<RetrievedMessageStatus>(
          userDataBackup,
          `message-status--${item.id}--${item.version}.json`,
          item
        ), // .mapLeft(e => e as ActivityResultFailure), // cast needed to fit the generic failuire type
        fromQueryEither(
          () =>
            messageStatusModel.deleteMessageStatusVersion(
              item.messageId,
              item.id
            ),
          "deleteMessageStatusVersion"
        )
      )
        // I only need the original item to be returned
        .map(_ => item)
    );
  };

  // recursively consumes an iterator and executes operations on every item
  const executeRecursiveOperations = (
    iterator: IResultIterator<RetrievedMessageStatus>
    // tslint:disable-next-line: readonly-array
  ): TaskEither<
    QueryFailure | BlobCreationFailure,
    readonly RetrievedMessageStatus[]
  > => {
    const taskMaybeArrayOfMessageStatus = tryCatch(
      iterator.executeNext,
      toQueryError
    )
      .chain(fromEither)
      .mapLeft(toQueryFailure);

    return taskMaybeArrayOfMessageStatus.foldTaskEither<
      QueryFailure | BlobCreationFailure,
      readonly RetrievedMessageStatus[]
    >(
      e => fromEither(left(e)),
      maybeResults =>
        maybeResults.fold(
          // if the iterator content is none, exit the recursion
          taskEither.of([]),
          items =>
            // executes backup&delete for this set of items
            array
              .sequence(taskEither)(items.map(executeOnSingleVersionItem))
              // recursive step
              .chain(actualResults =>
                executeRecursiveOperations(iterator).map(nextResult => [
                  ...actualResults,
                  ...nextResult
                ])
              )
        )
    );
  };
  return executeRecursiveOperations(
    messageStatusModel.findAllVersionsByModelId(message.id)
  );
};

/**
 * Explores the user data structures and deletes all documents and blobs. Before that saves a blob for every found document in a dedicated storage folder
 * Versioned models are backupped with a blob for each document version.
 * Deletions happen after and only if the respective document has been successfully backupped.
 * Backups and deletions of parent models happen after and only if every child model has been backupped and deleted successfully (example: Message and MessageStatus).
 * This is important because children are found from their parents and otherwise it would create dangling models in case of an error occur.
 *
 * @param param0.messageModel instance of MessageModel
 * @param param0.messageStatusModel instance of MessageStatusModel
 * @param param0.profileModel instance of ProfileModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.fiscalCode identifier of the user
 */
export const backupAndDeleteAllUserData = ({
  messageModel,
  messageStatusModel,
  profileModel,
  userDataBackup,
  fiscalCode
}: {
  messageModel: MessageModel;
  messageStatusModel: MessageStatusModel;
  profileModel: ProfileModel;
  userDataBackup: IBlobServiceInfo;
  fiscalCode: FiscalCode;
}) => {
  return fromQueryEither<ReadonlyArray<RetrievedMessageWithContent>>(
    () => iteratorToArray(messageModel.findMessages(fiscalCode)),
    "findMessages"
  )
    .foldTaskEither(
      e => fromEither(left(e)),
      messages => {
        return array.sequence(taskEither)(
          messages.map(message => {
            // cast needed because findMessages has a wrong signature
            // tslint:disable-next-line: no-any
            const retrievedMessage = (message as any) as RetrievedMessageWithoutContent;
            return sequenceT(taskEitherSeq)(
              backupAndDeleteMessageContent(),
              backupAndDeleteMessageStatus({
                message: retrievedMessage,
                messageStatusModel,
                userDataBackup
              }),
              backupAndDeleteMessage({
                message: retrievedMessage,
                messageModel,
                userDataBackup
              })
            );
          })
        );
      }
    )
    .chain(_ =>
      backupAndDeleteProfile({ profileModel, userDataBackup, fiscalCode })
    );
};
export interface IActivityHandlerInput {
  messageModel: MessageModel;
  messageStatusModel: MessageStatusModel;
  notificationModel: NotificationModel;
  notificationStatusModel: NotificationStatusModel;
  profileModel: ProfileModel;
  messageContentBlobService: BlobService;
  userDataBackupBlobService: BlobService;
  userDataBackupContainerName: NonEmptyString;
}

/**
 * Factory methods that builds an activity function
 */
export function createDeleteUserDataActivityHandler({
  messageModel,
  messageStatusModel,
  profileModel,
  userDataBackupBlobService,
  userDataBackupContainerName
}: IActivityHandlerInput): (
  context: Context,
  input: unknown
) => Promise<ActivityResult> {
  return (context: Context, input: unknown) =>
    fromEither(
      ActivityInput.decode(input).mapLeft<ActivityResultFailure>(
        (reason: t.Errors) =>
          InvalidInputFailure.encode({
            kind: "INVALID_INPUT_FAILURE",
            reason: readableReport(reason)
          })
      )
    )
      .chain(({ fiscalCode, userDataDeleteRequestId }) =>
        backupAndDeleteAllUserData({
          fiscalCode,
          messageModel,
          messageStatusModel,
          profileModel,
          userDataBackup: {
            blobService: userDataBackupBlobService,
            containerName: userDataBackupContainerName,
            folder: `${userDataDeleteRequestId}-${Date.now()}` as NonEmptyString
          }
        })
      )
      .bimap(
        failure => {
          logFailure(context)(failure);
          return failure;
        },
        _ =>
          ActivityResultSuccess.encode({
            kind: "SUCCESS"
          })
      )
      .run()
      .then(e => e.value);
}
