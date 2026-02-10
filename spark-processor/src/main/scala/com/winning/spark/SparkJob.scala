package com.winning.spark

import com.winning.spark.config.ConfigLoader
import com.winning.spark.datasource.SourceFactory
import com.winning.spark.processor.{DataCleaner, DataTransformer, DataValidator}
import com.winning.spark.output.ParquetWriter

object SparkJob {
  def main(args: Array[String]): Unit = {
    try {
      // Load configuration
      val config = ConfigLoader.load()
      
      // Initialize Spark Session
      val spark = SparkSessionManager.getOrCreate(config.spark)
      
      println(s"========================================")
      println(s"Starting Spark Job: ${config.spark.appName}")
      println(s"========================================")
      
      // Read data from source
      println(s"Reading data from ${config.datasource.`type`} source: ${config.datasource.path}")
      val source = SourceFactory.create(config.datasource)
      val rawDF = source.read(spark, config.datasource)
      
      val initialCount = rawDF.count()
      println(s"Loaded $initialCount records")
      
      // Process data
      println("Applying data validation...")
      val validatedDF = new DataValidator().process(rawDF, config.processor)
      
      println("Applying data cleaning...")
      val cleanedDF = new DataCleaner().process(validatedDF, config.processor)
      
      println("Applying data transformation...")
      val transformedDF = new DataTransformer().process(cleanedDF, config.processor)
      
      val finalCount = transformedDF.count()
      println(s"Processed $finalCount records (${initialCount - finalCount} filtered)")
      
      // Write output
      println(s"Writing output to ${config.output.path}")
      val writer = new ParquetWriter()
      writer.write(transformedDF, config.output)
      
      println(s"========================================")
      println(s"Job completed successfully!")
      println(s"Output written to: ${config.output.path}")
      println(s"========================================")
      
    } catch {
      case e: Exception =>
        println(s"========================================")
        println(s"Job failed: ${e.getMessage}")
        println(s"========================================")
        e.printStackTrace()
        System.exit(1)
    } finally {
      SparkSessionManager.stop()
    }
  }
}
