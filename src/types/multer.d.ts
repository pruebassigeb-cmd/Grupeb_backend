declare module "multer" {
  import { RequestHandler } from "express";

  interface Options {
    storage?: StorageEngine;
    limits?: {
      fieldNameSize?: number;
      fieldSize?: number;
      fields?: number;
      fileSize?: number;
      files?: number;
      parts?: number;
      headerPairs?: number;
    };
    fileFilter?: (
      req: Express.Request,
      file: File,
      callback: (error: Error | null, acceptFile: boolean) => void
    ) => void;
  }

  interface StorageEngine {}

  interface File {
    fieldname:    string;
    originalname: string;
    encoding:     string;
    mimetype:     string;
    size:         number;
    buffer:       Buffer;
    destination:  string;
    filename:     string;
    path:         string;
  }

  interface Multer {
    single(fieldname: string): RequestHandler;
    array(fieldname: string, maxCount?: number): RequestHandler;
    fields(fields: { name: string; maxCount?: number }[]): RequestHandler;
    none(): RequestHandler;
    any(): RequestHandler;
    memoryStorage(): StorageEngine;
  }

  function multer(options?: Options): Multer & { memoryStorage(): StorageEngine };

  namespace multer {
    function memoryStorage(): StorageEngine;
  }

  export = multer;
}