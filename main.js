import catenv from "catenv";
import { SerialPort, ReadlineParser } from 'serialport';
import moodlog from "moodlog";
import { Groq } from "groq-sdk";
import NodeWebcam from "node-webcam";
import { Jimp } from "jimp";
import fs from "fs";

catenv.load();

const groq = new Groq({ apiKey: process.env.GROQ_API });

moodlog.define('error', { emoji: '🚨', color: 'red' });
moodlog.define('info', { emoji: 'ℹ️', color: 'blue' });

// Webcam setup
const webcam = NodeWebcam.create({
  width: 640,
  height: 480,
  quality: 100,
  delay: 0,
  saveShots: true,
  output: "png",
  device: false,
  callbackReturn: "location",
  verbose: false,
});

const port = new SerialPort({
  path: '/dev/ttyUSB0',
  baudRate: 9600,
});

const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

parser.on('data', (data) => {
  console.log('Arduino says:', data);
});

const captureImage = async () => {
  try {
    return new Promise((resolve, reject) => {
      webcam.capture("frame", (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  } catch (error) {
    moodlog.error("Failed to capture image from webcam.");
  }
}

const processImage = async (imagePath) => {
  try {
    const imageData = fs.readFileSync(imagePath).toString("base64");
    moodlog.info("Sending image to Groq for classification.");

    const chatCompletion = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Classify the object inside the white box (bin) in this image as 'plastic', 'organic', 'metal', or 'null' (if no object is present inside the box). If there is any hand or human interaction inside the box, classify as 'null'. Ignore all objects and elements outside the white box—analyze only the object inside the box. Examples for each class: 
- 'plastic': plastic bottles, plastic bags, food containers, plastic wrappers, plastic cups, straws, plastic utensils, shampoo/soap/detergent bottles, plastic toys, pens, combs, toothbrushes, containers, lids, packaging films, CD/DVDs, disposable gloves, plastic chairs, crates, buckets, trays  
- 'organic': fruits, vegetables, paper, food scraps, leaves, flowers, tea leaves, coffee grounds, fruit peels, bread, meat, fish, nuts, seeds, eggshells, grass, sawdust, wood chips, cotton, wool, hay, compostable items  
- 'metal': tin cans, aluminum foil, metal utensils, bottle caps, screws, coins, cutlery, metal lids, keys, nails, bolts, metal tools, kitchenware, jewelry, coins, wires, metal pipes, cans, cookware, metallic decorations, watch parts  
- 'null': the box is empty, contains only non-classifiable items, or has any hand/human interaction inside the box.  
Respond only with the classification.`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${imageData}` },
            },
          ],
        },
      ],
    });

    const result = chatCompletion.choices[0].message.content.trim().toLowerCase();
    moodlog.info("Image classified as: " + result);

    return result;
  } catch (error) {
    moodlog.error("Failed to process image for classification.");
  }
}

const analyse = async () => {
  moodlog.info("Capturing image from webcam...");
  const imagePath = await captureImage();
  if (imagePath) {
    const classification = await processImage(imagePath);
  } else {
    moodlog.error("No image captured.");
  }
}

const main = async (threshold = 2000000, interval = 4000) => {
  let previousImage = null;

  const captureAndCompare = async () => {
    try {
      // Capture image from webcam
      webcam.capture("current", async (err, data) => {
        if (err) {
          console.error("Error capturing webcam:", err);
          return;
        }

        // Read image using Jimp
        const currentImage = await Jimp.read(data);

        if (previousImage) {
          let pixelsChanged = 0;

          // Manual pixel comparison (Jimp v1.0+ doesn't have diff method)
          const width = currentImage.bitmap.width;
          const height = currentImage.bitmap.height;

          // Iterate through each pixel
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const currentPixel = currentImage.getPixelColor(x, y);
              const previousPixel = previousImage.getPixelColor(x, y);

              // Compare RGBA values
              if (currentPixel !== previousPixel) {
                pixelsChanged++;
              }
            }
          }

          const totalPixels = width * height;
          const percentageChanged = (pixelsChanged / totalPixels) * 100;

          // Trigger analyse if change exceeds threshold
          if (pixelsChanged > threshold) {
            moodlog.info(`Motion detected! ${pixelsChanged} pixels changed (${percentageChanged.toFixed(2)}%)`);
            await analyse();
          }
        }

        // Update previous image
        previousImage = currentImage.clone();

        // Schedule next capture
        setTimeout(captureAndCompare, interval);
      });
    } catch (error) {
      console.error("Error in captureAndCompare:", error);
      // Retry after interval even on error
      setTimeout(captureAndCompare, interval);
    }
  };

  // Start monitoring
  captureAndCompare();
}

main().catch(console.error);