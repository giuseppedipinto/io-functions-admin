import { Context } from "@azure/functions";
import { BlobService } from "azure-storage";
import * as TE from "fp-ts/lib/TaskEither";
import { CosmosErrors } from "@pagopa/io-functions-commons/dist/src/utils/cosmosdb_model";
import { pipe } from "fp-ts/lib/function";
import {
  ActivityResultFailure,
  BlobCreationFailure,
  DocumentDeleteFailure,
  IBlobServiceInfo,
  QueryFailure
} from "./types";

/**
 * To be used for exhaustive checks
 */
// eslint-disable-next-line prefer-arrow/prefer-arrow-functions
export function assertNever(_: never): never {
  throw new Error("should not have executed this");
}

const toString = (err: unknown): string =>
  typeof err === "string"
    ? err
    : err instanceof Error
    ? err.message
    : JSON.stringify(err);

/**
 * to cast an error to QueryFailure
 *
 * @param err
 */
export const toQueryFailure = (err: Error | CosmosErrors): QueryFailure =>
  QueryFailure.encode({
    kind: "QUERY_FAILURE",
    reason: err instanceof Error ? err.message : `CosmosError: ${toString(err)}`
  });

/**
 * to cast an error to a DocumentDeleteFailure
 *
 * @param err
 */
export const toDocumentDeleteFailure = (
  err: Error | CosmosErrors
): DocumentDeleteFailure =>
  DocumentDeleteFailure.encode({
    kind: "DELETE_FAILURE",
    reason: err instanceof Error ? err.message : toString(err)
  });

/**
 * Logs depending on failure type
 *
 * @param context the Azure functions context
 * @param failure the failure to log
 */
export const logFailure = (context: Context, logPrefix: string) => (
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
        `${logPrefix}|Error saving blob|ERROR=${failure.reason}`
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

/**
 * Saves data into a dedicated blob
 *
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
): TE.TaskEither<BlobCreationFailure, T> =>
  pipe(
    TE.taskify<Error, BlobService.BlobResult>(cb =>
      blobService.createBlockBlobFromText(
        containerName,
        `${folder}${folder ? "/" : ""}${blobName}`,
        JSON.stringify(data),
        cb
      )
    )(),
    TE.mapLeft(err =>
      BlobCreationFailure.encode({
        kind: "BLOB_FAILURE",
        reason: err.message
      })
    ),
    TE.map(_ => data)
  );
